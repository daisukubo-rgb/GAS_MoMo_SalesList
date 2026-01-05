/**
 * 営業リスト作成ツール (Places API + Gemini API)
 * 仕様：UI分割入力対応 & MoMo様AI研修プロンプト & gemini-3.0-flash指定 & URL返却
 * 更新：トップページに加え、会社概要ページも取得してAI分析精度を向上
 * @author GASサポーター
 */

const PROPS = PropertiesService.getScriptProperties();
const GOOGLE_API_KEY = PROPS.getProperty('GOOGLE_API_KEY');
const SPREADSHEET_ID = PROPS.getProperty('SPREADSHEET_ID');
const SHEET_NAME = '営業リスト';

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('AI営業リスト作成ツール')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function executeSearch(keyword, userInstruction, limitParam) {
  if (!GOOGLE_API_KEY || !SPREADSHEET_ID) {
    throw new Error('APIキーまたはシートIDが設定されていません。GASのスクリプトプロパティを確認してください。');
  }

  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName(SHEET_NAME);
    
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow([
        '会社名', 'Gemini分析結果', 'WebサイトURL', '電話番号', '住所', 'メールアドレス', '問い合わせフォームURL', '取得日時'
      ]);
      sheet.getRange(1, 1, 1, 8).setFontWeight('bold').setBackground('#f3f3f3');
      sheet.setFrozenRows(1);
    }

    let existingUrls = new Set();
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) { 
      const urlColumnValues = sheet.getRange(2, 3, lastRow - 1, 1).getValues(); 
      urlColumnValues.flat().forEach(url => {
        if (url) existingUrls.add(url);
      });
    }

    const targetCount = parseInt(limitParam) || 10;
    let successCount = 0;
    let duplicateCount = 0;
    let pageToken = null;
    let apiCallCount = 0;

    do {
      if (apiCallCount >= 5) break;

      const searchResult = searchPlaces(keyword, pageToken);
      const places = searchResult.places;
      pageToken = searchResult.nextPageToken;
      apiCallCount++;

      if (!places || places.length === 0) break; 

      for (const place of places) {
        if (successCount >= targetCount) break;
        if (!place.websiteUri) continue;
        if (existingUrls.has(place.websiteUri)) {
          duplicateCount++;
          continue;
        }

        // ここでサイト情報を取得（トップページ＋会社概要）
        const siteData = getSiteContent(place.websiteUri);
        
        let geminiAnalysis = "分析不可(サイト情報なし)";
        if (siteData.text) {
          geminiAnalysis = analyzeWithGemini(siteData.text, userInstruction);
        }

        const rowData = [
          place.displayName.text,   
          geminiAnalysis,           
          place.websiteUri,         
          place.nationalPhoneNumber || '', 
          place.formattedAddress,   
          siteData.emails.join(', '), 
          siteData.contactUrl,
          new Date()                
        ];

        sheet.appendRow(rowData);
        existingUrls.add(place.websiteUri);
        successCount++;
        Utilities.sleep(1000); 
      }

      if (successCount < targetCount && pageToken) {
        Utilities.sleep(2000);
      }

    } while (successCount < targetCount && pageToken);

    let msg = `目標${targetCount}件に対し、${successCount}件の新規リストを作成しました！`;
    if (duplicateCount > 0) {
      msg += `\n(重複によりスキップ：${duplicateCount}件 → 代わりに次を検索しました)`;
    }
    if (successCount < targetCount) {
      msg += `\n(※検索可能な企業が底をつきました)`;
    }

    return { 
      success: true, 
      message: msg,
      count: successCount,
      url: ss.getUrl() 
    };

  } catch (e) {
    Logger.log('Error: ' + e.toString());
    throw new Error('処理中にエラーが発生しました: ' + e.message);
  }
}

function searchPlaces(textQuery, pageToken = null) {
  const endpoint = 'https://places.googleapis.com/v1/places:searchText';
  const payload = { textQuery: textQuery, languageCode: 'ja', pageSize: 20 };
  if (pageToken) payload.pageToken = pageToken;

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Goog-Api-Key': GOOGLE_API_KEY,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,nextPageToken'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(endpoint, options);
  const json = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) {
    throw new Error(`Places API Error: ${json.error ? json.error.message : 'Unknown error'}`);
  }
  return { places: json.places || [], nextPageToken: json.nextPageToken || null };
}

// ★修正：トップページ＋会社概要ページを取得するロジックに変更
function getSiteContent(url) {
  try {
    // 1. トップページの取得
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: false });
    if (response.getResponseCode() !== 200) return { text: null, emails: [], contactUrl: '' };
    
    const html = response.getContentText();
    
    // メールアドレス・問い合わせフォーム探索（トップページから）
    const emailRegex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const foundEmails = html.match(emailRegex) || [];
    const contactUrl = findContactPageUrl(html, url);

    // テキスト抽出（トップページ）
    let homeText = extractTextFromHtml(html);

    // 2. 会社概要ページの探索と取得
    const companyUrl = findCompanyProfileUrl(html, url);
    let companyText = "";

    // もし会社概要URLが見つかり、かつトップページと違うURLなら取得しに行く
    if (companyUrl && companyUrl !== url) {
      try {
        // 会社概要ページは読み込みに失敗してもエラーにせず、無視して進む
        const compResponse = UrlFetchApp.fetch(companyUrl, { muteHttpExceptions: true, validateHttpsCertificates: false });
        if (compResponse.getResponseCode() === 200) {
          const compHtml = compResponse.getContentText();
          companyText = extractTextFromHtml(compHtml);
          
          // 会社概要ページからもメールアドレスを探して追加しておく
          const compEmails = compHtml.match(emailRegex) || [];
          foundEmails.push(...compEmails);
        }
      } catch (e) {
        console.log("会社概要ページの取得に失敗: " + companyUrl);
      }
    }

    // 3. テキストの結合（Geminiに渡す情報）
    let combinedText = `【トップページ情報】\n${homeText}\n\n【会社概要・企業情報ページ情報】\n${companyText}`;
    
    // Geminiへの送信量が増えるため、20000文字まで許可（多すぎる場合はカット）
    if (combinedText.length > 20000) combinedText = combinedText.substring(0, 20000); 
    
    return { text: combinedText, emails: [...new Set(foundEmails)], contactUrl: contactUrl };

  } catch (e) {
    return { text: null, emails: [], contactUrl: '' };
  }
}

// ★追加：HTMLからテキストのみを抽出するヘルパー関数
function extractTextFromHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, "")
    .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function findContactPageUrl(html, baseUrl) {
  const linkRegex = /<a[^>]+href=["'](.*?)["'][^>]*>(.*?)<\/a>/gi;
  let match;
  const targetKeywords = /contact|inquiry|form|support|お問い合わせ|お問合せ|ご相談|受付/i;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]; 
    const text = match[2]; 
    if (targetKeywords.test(href) || targetKeywords.test(text)) return resolveUrl(baseUrl, href);
  }
  return ''; 
}

// ★追加：会社概要ページのURLを探す関数
function findCompanyProfileUrl(html, baseUrl) {
  const linkRegex = /<a[^>]+href=["'](.*?)["'][^>]*>(.*?)<\/a>/gi;
  let match;
  // リンクテキストまたはURLに含まれていそうなキーワード
  const targetKeywords = /会社概要|企業情報|会社案内|企業概要|About|Company|Profile|Overview/i;
  
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]; 
    const text = match[2]; 
    
    if (targetKeywords.test(text) || targetKeywords.test(href)) {
      return resolveUrl(baseUrl, href);
    }
  }
  return null; 
}

function resolveUrl(baseUrl, href) {
  if (href.startsWith('http')) return href; 
  if (href.startsWith('mailto:')) return ''; 
  if (href.startsWith('tel:')) return ''; 
  const cleanBase = baseUrl.replace(/\/$/, '');
  if (href.startsWith('/')) {
    const domain = cleanBase.match(/^https?:\/\/[^\/]+/)[0];
    return domain + href;
  } else {
    return cleanBase + '/' + href;
  }
}

function analyzeWithGemini(contextText, userInstruction) {
  if (!contextText) return "Webサイトの内容を取得できませんでした";
  const modelName = 'gemini-3-flash-preview'; 
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GOOGLE_API_KEY}`;
  const userPromptPart = userInstruction ? userInstruction : "特に追加の指示はありません。基本指示に従って要約してください。";

  const finalPrompt = `
    あなたは法人向け生成AI研修の営業担当です。
    提供されたWebサイトのテキスト情報（トップページおよび会社概要）を分析し、MoMoの営業リスト作成に役立つ情報を簡潔に抽出してください。下記5項目に従って分析してください。

【🔰MoMoの研修事業について（前提条件）】
● 提供内容：
- ChatGPTなどの「生成AIツール」の活用スキルを実務レベルで習得する企業研修
- 業種・職種に応じてカスタマイズ可能（例：営業部向け、マーケティング部向け、福祉業界など）
● 特徴：
- 業務改善・効率化・企画力強化をテーマにした実践的な内容
- 従来の集合型研修に加え、OEM提供（eラーニング形式）にも対応
- 導入企業の「成果」につながる継続的サポート付き
● 想定している主なニーズ（企業側の課題）：
- 生産性の向上や業務効率化を目指している
- 社内でのDX（デジタル活用）やAI活用に取り組み始めている
- SNS運用・営業・人事・教育などで企画やアウトプットの質を高めたい
- 社員に最新スキルを習得させたい／社内教育コンテンツを拡充したい

---
 
    【分析してほしい内容】  
    1. 【事業領域】  
     この会社はどの業種・業務を主に扱っていますか？（例：不動産業・製造業・福祉・教育など）  

    2.会社規模（推測ではなく、企業ページから探す。「企業情報」などのセクションを確認すること。なければ「なし」と回答）
     設立年：
     社員数：
     資本金：
     

    3. 【AI研修との親和性】  
     生成AI（ChatGPT等）を使うことで、**業務改善や生産性向上が見込める業務領域**はありますか？ 可能性が高い場合はその理由を述べてください。  

    4. 【想定される研修ニーズ】  
     以下のMoMoのAI研修テーマのうち、ニーズがありそうなものを選んでください（複数可）  
       - 生成AI × 人事  
       - 生成AI × 営業  
       - 生成AI × マーケティング  
       - 生成AI × SNS運用  
       - 生成AI × 経営企画  
       - 生成AI × 業界別研修（※業界名も明記）

5. 【導入可能性のスコア】  
    AI研修のニーズがありそうかを、下記の5段階でスコア化してください。  
      - ★★★★★：ニーズ非常に高い  
      - ★★★★☆：ニーズ高い  
      - ★★★☆☆：普通  
      - ★★☆☆☆：やや低い  
      - ★☆☆☆☆：ほぼ無い  

6. 【営業アプローチにおけるヒント】  
      MoMoの営業担当者がこの会社に提案する際、どういった切り口・キーワードでアプローチすると良さそうかを教えてください。（例：「DX人材育成」「SNS運用の効率化」「新入社員研修の刷新」など）
---
    必要があれば、企業の公式サイトに書かれていない“仮説”も交えて、推論してください。
    【ユーザーからの追加指示】
    ${userPromptPart}
    【分析対象のWebサイト情報】
    ${contextText}
  `;

  const payload = { contents: [{ parts: [{ text: finalPrompt }] }] };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    const json = JSON.parse(response.getContentText());
    if (json.error) return "AI分析エラー: " + (json.error.message || "詳細不明");
    if (json.candidates && json.candidates.length > 0) return json.candidates[0].content.parts[0].text;
    return "分析結果なし";
  } catch (e) {
    return "AI通信エラー: " + e.message;
  }
}
