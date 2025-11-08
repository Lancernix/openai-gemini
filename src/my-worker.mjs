const MAX_RETRIES = 3; // 最大重试次数，保持在全局
const API_CLIENT = "google-genai-sdk/1.28.0"; // 兜底 API_CLIENT

export default {
  async fetch (request, env) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    const errHandler = (err) => {
      console.error(err);
      // 确保错误响应也应用 CORS
      return new Response(err.message, fixCors({ status: err.status ?? 500 }));
    };

    try {
      // ----------------------------------------------------
      // 1. 客户端鉴权逻辑优化：支持 x-goog-api-key 或 Authorization
      // ----------------------------------------------------
      let clientAuthCode = null;
      // 优先从 x-goog-api-key 获取客户端鉴权码
      const xGoogApiKeyFromClient = request.headers.get("x-goog-api-key");
      if (xGoogApiKeyFromClient) {
          clientAuthCode = xGoogApiKeyFromClient;
      } else {
          // 如果没有 x-goog-api-key，则从 Authorization: Bearer 中获取
          const authHeader = request.headers.get("Authorization");
          clientAuthCode = authHeader?.split(" ")[1];
      }

      // 从环境变量中获取所有 Google API Keys 和期望的客户端鉴权码
      const allGoogleApiKeys = env.GOOGLE_GEMINI_API_KEYS?.split(',').map(k => k.trim()).filter(Boolean);
      const expectedAuthCode = env.AUTH_CODE;

      // 服务器配置检查
      if (!allGoogleApiKeys || allGoogleApiKeys.length === 0) {
        throw new HttpError("Server misconfiguration: GOOGLE_GEMINI_API_KEYS is not set or empty.", 500);
      }
      if (!expectedAuthCode) {
        throw new HttpError("Server misconfiguration: AUTH_CODE is not set.", 500);
      }

      // 客户端鉴权验证
      if (!clientAuthCode || clientAuthCode !== expectedAuthCode) {
        throw new HttpError("Unauthorized: Invalid authorization code.", 401);
      }

      // ----------------------------------------------------
      // 2. URL 拼接优化：直接代理 Gemini 规范的路径
      // ----------------------------------------------------
      // 客户端直接发送 Gemini 规范的 URL，我们只需修改 host
      const targetUrl = new URL(request.url);
      targetUrl.host = "generativelanguage.googleapis.com";
      targetUrl.protocol = "https:";
      targetUrl.port = "443"; // 明确指定 443 端口

      let lastError = null;
      const availableKeys = [...allGoogleApiKeys]; // 每次重试循环使用一个新的可用密钥列表
      let attempt = 0;

      // 重试循环
      while (attempt < MAX_RETRIES && availableKeys.length > 0) {
        const selectedApiKeyIndex = Math.floor(Math.random() * availableKeys.length);
        const selectedApiKey = availableKeys[selectedApiKeyIndex];
        // 从当前会话的可用 Key 列表中移除已选择的 Key，以便下次重试使用不同的 Key
        availableKeys.splice(selectedApiKeyIndex, 1);

        try {
          // 克隆请求，因为请求体只能读取一次，重试需要新的请求克隆
          const clonedRequest = request.clone();
          // 读取请求体，对于 POST/PUT 请求，通常是 JSON。使用 arrayBuffer 以便直接转发。
          const requestBody = (clonedRequest.method === "POST" || clonedRequest.method === "PUT") ? await clonedRequest.arrayBuffer() : null;

          // 构建转发头部
          const headers = new Headers(clonedRequest.headers);
          headers.delete("Authorization"); // 移除客户端提供的 Authorization (可能包含 AUTH_CODE)
          headers.delete("x-goog-api-key"); // 移除客户端提供的 x-goog-api-key (可能包含 AUTH_CODE)

          headers.set("x-goog-api-key", selectedApiKey); // 添加选定的真实 Google API Key

          // 确保 Content-Type 被正确设置，特别是对于 POST/PUT 请求
          // 如果客户端没有设置，或者设置不正确，我们默认假设为 application/json
          if (requestBody && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
          }
          // 如果客户端没有提供 x-goog-api-client，我们提供一个默认的
          if (!headers.has("x-goog-api-client")) {
            headers.set("x-goog-api-client", API_CLIENT);
          }

          const proxyRequest = new Request(targetUrl.toString(), {
            method: clonedRequest.method,
            headers: headers,
            body: requestBody, // 直接使用原始请求体
            redirect: "follow",
          });

          const response = await fetch(proxyRequest);

          // 检查 Google API 返回的错误状态码，决定是否重试
          // 401 (Unauthorized - 通常是 Key 问题), 429 (Too Many Requests - 限流), 5xx (服务器错误) 都尝试重试
          if ([401, 429].includes(response.status) || response.status >= 500) {
              // 如果还有其他 Key 可用，尝试下一个 Key
              if (availableKeys.length > 0) {
                // 必须读取并丢弃响应体，以防止资源泄漏，然后才能重试
                await response.arrayBuffer();
                attempt++;
                lastError = new HttpError(`Google API returned status ${response.status}: ${response.statusText}`, response.status);
                continue; // 继续下一次循环，尝试下一个 Key
              } else { // 没有更多 Key 可用，直接抛出这个错误
                throw new HttpError(`Google API returned status ${response.status}: ${response.statusText}`, response.status);
              }
          }

          // 如果响应成功，或者是不需要重试的错误（如 400 Bad Request），则直接返回
          return new Response(response.body, fixCors(response));

        } catch (innerErr) {
          lastError = innerErr;
          console.warn(`Attempt ${attempt + 1} failed with key ending in "...${selectedApiKey.slice(-5)}":`, innerErr.message);

          // 如果是 HttpError (非 401/429/5xx) 或者其他网络错误 (如 DNS 失败)，
          // 且没有更多 Key，或者该错误类型不应重试，则直接抛出
          // 我们这里只对 401/429/5xx 尝试重试，其他错误直接抛出
          const shouldRetry = (innerErr instanceof HttpError && ([401, 429].includes(innerErr.status) || innerErr.status >= 500));

          if (!shouldRetry || availableKeys.length === 0) {
             throw innerErr; // 不重试，直接抛出
          }

          // 否则，如果是应重试的错误，且还有可用 Key，则继续重试
          attempt++;
          continue;
        }
      }

      // 如果所有重试都失败了
      if (lastError) {
        throw new HttpError(`All ${MAX_RETRIES} API key attempts failed: ${lastError.message}`, lastError.status || 503); // 503 Service Unavailable
      } else {
        // 这通常不会发生，除非 availableKeys 一开始就是空的（已在前置检查中处理）
        throw new HttpError("No API keys available to process the request after all attempts.", 503);
      }

    } catch (err) {
      return errHandler(err);
    }
  }
};

// ========================================================================
// 辅助函数和常量，保持不变或微调
// ========================================================================

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

// 确保 fixCors 返回一个包含 status 和 headers 的对象，而不是 Response 对象本身
const fixCors = (responseOptions = {}) => {
  const headers = responseOptions.headers instanceof Headers ? responseOptions.headers : new Headers(responseOptions.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status: responseOptions.status, statusText: responseOptions.statusText };
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", // 允许更多方法
      "Access-Control-Allow-Headers": "*", // 允许所有头部
      "Access-Control-Max-Age": "86400", // 缓存预检请求结果 24 小时
    }
  });
};
