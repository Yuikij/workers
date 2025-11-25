export default {
    async fetch(request, env) {
        // 0. 配置密码 (优先读取环境变量，否则使用默认值 123458)
        const PASSWORD = env.ACCESS_PASSWORD || "123458";
        const url = new URL(request.url);

        // ==========================================
        // 第一部分:安全门卫 (鉴权逻辑)
        // ==========================================
        let isAuthorized = false;
        let shouldSetCookie = false;

        // 1. 检查 URL 参数 (?pw=xxx) - 用于直接访问
        const urlPassword = url.searchParams.get("pw");
        if (urlPassword === PASSWORD) {
            isAuthorized = true;
            shouldSetCookie = true; // 既然密码对了，就顺便给个 Cookie，方便后续加载图片
        }

        // 2. 检查 Cookie - 用于后续访问 (图片/视频/刷新页面)
        const cookieHeader = request.headers.get("Cookie") || "";
        if (!isAuthorized && cookieHeader.includes(`cf_proxy_auth=${PASSWORD}`)) {
            isAuthorized = true;
        }

        // 3. 处理登录表单提交 (手动输入密码)
        if (!isAuthorized && request.method === "POST") {
            try {
                const formData = await request.clone().formData();
                const inputPass = formData.get("password");
                if (inputPass === PASSWORD) {
                    // 密码正确：重定向回当前页面 (转为 GET)，并设置 Cookie
                    return new Response(null, {
                        status: 302,
                        headers: {
                            "Location": url.pathname + url.search, // 保持原来的路径和参数
                            "Set-Cookie": `cf_proxy_auth=${PASSWORD}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` // Cookie 有效期1年
                        }
                    });
                }
            } catch (e) {
                // 忽略表单解析错误
            }
        }

        // 4. 如果依然未授权，拦截请求
        if (!isAuthorized) {
            // 如果是媒体资源请求，直接返回 401，不返回登录页 (避免图片位置显示网页代码)
            if (url.pathname.startsWith("/proxy/") || url.pathname.startsWith("/amplify_video/") || url.pathname.startsWith("/ext_tw_video/")) {
                return new Response("Access Denied", { status: 401 });
            }
            // 否则返回登录页面 HTML
            return getLoginPage();
        }

        // ==========================================
        // 第二部分：核心业务逻辑 (鉴权通过后执行)
        // ==========================================

        // 执行原来的业务逻辑 (封装在 serveOriginalContent 函数中)
        const response = await serveOriginalContent(request, env);

        // 如果是通过 URL 参数 (?pw=) 进来的，我们需要在返回内容的头上贴个 Cookie
        // 这样浏览器下次请求图片时就会自动带上 Cookie
        if (shouldSetCookie) {
            const newHeaders = new Headers(response.headers);
            newHeaders.set("Set-Cookie", `cf_proxy_auth=${PASSWORD}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);

            return new Response(response.body, {
                status: response.status,
                headers: newHeaders
            });
        }

        return response;
    }
};

// === 辅助函数：生成登录页面 ===
function getLoginPage() {
    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>访问受限</title>
      <style>
        body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f0f2f5; font-family: -apple-system, sans-serif; }
        .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; width: 320px; max-width: 90%; }
        h3 { margin-top: 0; color: #333; }
        input { width: 100%; padding: 12px; margin: 15px 0; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; font-size: 16px; outline: none; transition: border 0.2s; }
        input:focus { border-color: #000; }
        button { width: 100%; padding: 12px; background: #000; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: bold; }
        button:hover { background: #333; }
        .hint { color: #666; font-size: 14px; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h3>🔒 访问受限</h3>
        <p class="hint">该内容仅限特定用户访问<br>请输入密码以继续</p>
        <form method="POST">
          <input type="password" name="password" placeholder="在此输入密码" required autofocus>
          <button type="submit">验证并进入</button>
        </form>
      </div>
    </body>
    </html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// === 原有业务逻辑 (封装在这里) ===
async function serveOriginalContent(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ==========================================
    // 功能一：增强型媒体代理 (支持 Range 和 CORS)
    // ==========================================
    if (path.startsWith("/proxy/")) {
        const originalUrl = request.url.split("/proxy/")[1];
        if (!originalUrl) return new Response("Missing URL", { status: 400 });

        const proxyHeaders = new Headers();
        // 使用 Chrome UA
        proxyHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        proxyHeaders.set("Referer", "https://twitter.com/");

        const range = request.headers.get("Range");
        if (range) {
            proxyHeaders.set("Range", range);
        }

        try {
            const mediaResponse = await fetch(originalUrl, {
                method: request.method,
                headers: proxyHeaders
            });

            const newHeaders = new Headers(mediaResponse.headers);
            newHeaders.set("Access-Control-Allow-Origin", "*");
            newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
            newHeaders.set("Access-Control-Allow-Headers", "Range");

            if (originalUrl.includes(".mp4") && !newHeaders.get("Content-Type")) {
                newHeaders.set("Content-Type", "video/mp4");
            }

            return new Response(mediaResponse.body, {
                status: mediaResponse.status,
                headers: newHeaders
            });

        } catch (e) {
            return new Response("Media Proxy Error: " + e.message, { status: 500 });
        }
    }

    // ==========================================
    // 功能二：页面渲染服务 (智能选源版)
    // ==========================================

    if (path === "/" || path.includes("favicon")) {
        return new Response("请在网址后面加上推特链接", { status: 200 });
    }

    const apiUrl = `https://api.fxtwitter.com${path}`;

    try {
        const apiResponse = await fetch(apiUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" }
        });

        if (!apiResponse.ok) {
            return new Response(`无法获取推文数据 (API Error: ${apiResponse.status})`, { status: 404 });
        }

        const data = await apiResponse.json();
        const tweet = data.tweet;

        if (!tweet) {
            return new Response("未找到推文内容", { status: 404 });
        }

        const toProxy = (src) => {
            if (!src) return "";
            return `${url.origin}/proxy/${src}`;
        };

        let mediaHtml = "";

        if (tweet.media && tweet.media.photos) {
            tweet.media.photos.forEach(photo => {
                mediaHtml += `<img src="${toProxy(photo.url)}" class="media-item" loading="lazy" />`;
            });
        }

        // === 核心修复：智能选择最佳视频源 ===
        if (tweet.media && tweet.media.videos) {
            tweet.media.videos.forEach(video => {
                let bestUrl = video.url; // 默认回退值

                // 如果有变体列表，从中挑选最佳 MP4
                if (video.variants && Array.isArray(video.variants)) {
                    // 1. 筛选出所有 mp4 格式
                    const mp4s = video.variants.filter(v => v.content_type === "video/mp4");

                    if (mp4s.length > 0) {
                        // 2. 按码率 (bitrate) 从大到小排序
                        mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                        // 3. 选中第一个（也就是最高清、有声音的那个）
                        bestUrl = mp4s[0].url;
                    }
                }

                // 使用选出来的 bestUrl 进行代理
                mediaHtml += `
            <video controls playsinline crossorigin="anonymous" poster="${toProxy(video.thumbnail_url)}" class="media-item" preload="metadata">
              <source src="${toProxy(bestUrl)}" type="video/mp4">
              您的浏览器不支持播放视频，请尝试下载。
            </video>`;
            });
        }

        const avatarUrl = toProxy(tweet.author.avatar_url);
        const textContent = tweet.text ? tweet.text.replace(/\n/g, "<br>") : "";
        const textContentPlain = tweet.text || ""; // 纯文本版本用于 meta 标签
        const dateStr = new Date(tweet.created_timestamp * 1000).toLocaleString('zh-CN');

        // 为微信分享准备预览图片
        let ogImage = "";
        if (tweet.media && tweet.media.photos && tweet.media.photos.length > 0) {
            // 优先使用照片
            ogImage = toProxy(tweet.media.photos[0].url);
        } else if (tweet.media && tweet.media.videos && tweet.media.videos.length > 0) {
            // 如果没有照片，使用视频缩略图
            ogImage = toProxy(tweet.media.videos[0].thumbnail_url);
        }
        // 如果都没有，使用作者头像
        if (!ogImage) {
            ogImage = avatarUrl;
        }

        const html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${textContentPlain}</title>
          
          <!-- Open Graph / 微信分享预览 -->
          <meta property="og:type" content="article">
          <meta property="og:title" content="${textContentPlain}">
          <meta property="og:description" content="发布于 ${dateStr}">
          <meta property="og:image" content="${ogImage}">
          <meta property="og:url" content="${request.url}">
          
          <!-- Twitter Card (也可能被某些平台使用) -->
          <meta name="twitter:card" content="summary_large_image">
          <meta name="twitter:title" content="${textContentPlain}">
          <meta name="twitter:description" content="发布于 ${dateStr}">
          <meta name="twitter:image" content="${ogImage}">
          
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f0f2f5; margin: 0; padding: 20px; color: #333; }
            .card { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); overflow: hidden; }
            .header { padding: 15px; display: flex; align-items: center; border-bottom: 1px solid #eee; }
            .avatar { width: 48px; height: 48px; border-radius: 50%; margin-right: 12px; object-fit: cover; }
            .name { font-weight: bold; font-size: 16px; }
            .screen-name { color: #536471; font-size: 14px; }
            .content { padding: 15px; font-size: 16px; line-height: 1.5; word-wrap: break-word; }
            .media-grid { display: flex; flex-direction: column; gap: 10px; margin-top: 15px; }
            .media-item { width: 100%; border-radius: 8px; max-height: 600px; object-fit: contain; background: #000; }
            .footer { padding: 15px; color: #536471; font-size: 14px; border-top: 1px solid #eee; }
            a { color: #1d9bf0; text-decoration: none; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="header">
              <img src="${avatarUrl}" class="avatar" alt="Avatar">
              <div>
                <div class="name">${tweet.author.name}</div>
                <div class="screen-name">@${tweet.author.screen_name}</div>
              </div>
            </div>
            <div class="content">
              ${textContent}
              <div class="media-grid">
                ${mediaHtml}
              </div>
            </div>
            <div class="footer">
              发布于: ${dateStr} <br><br>
              <a href="${tweet.url}" target="_blank">🔗 跳转到原推特x</a>
            </div>
          </div>
        </body>
        </html>
      `;

        return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" }
        });

    } catch (e) {
        return new Response("Error: " + e.message, { status: 500 });
    }
}