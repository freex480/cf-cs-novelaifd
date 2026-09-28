import { unzipSync } from 'fflate';
export default {
  async fetch(request, env, ctx) {
    // ---------------------------------------------------------
    // 【1. 配置区 - 请修改这里】
    // ---------------------------------------------------------
    
    // 你的中转站访问密码 (前端 URL 里传入的 sq 参数)
    const MY_SECRET_KEY = 'hua-vgFrKFiCb7uJuCfb'; 
    
    // 你的 NovelAI 官方 API Token (长串字符，切勿泄露)
    const NAI_API_TOKEN = 'pst-在这里填入你抓包获取的NovelAI真实Token';

    // ---------------------------------------------------------
    // 【2. 请求解析与鉴权】
    // ---------------------------------------------------------
    const url = new URL(request.url);
    const prompt = url.searchParams.get('tag'); // 接收正向提示词
    const sq = url.searchParams.get('sq');      // 接收密码
    const model = url.searchParams.get('model') || 'nai-diffusion-3'; // 默认 V3 模型
    const actionType = url.searchParams.get('action') || 'generate';

    // 校验密码防刷
    if (sq !== MY_SECRET_KEY) {
      return new Response('Unauthorized: 密码错误或未提供', { status: 403 });
    }

    if (!prompt) {
      return new Response('Bad Request: 缺少 tag(提示词) 参数', { status: 400 });
    }

    // ---------------------------------------------------------
    // 【3. 组装 NovelAI 请求 Payload】
    // ---------------------------------------------------------
    // 你可以在这里硬编码加上画风词，保证出图质量
    const finalPrompt = `${prompt}, best quality, amazing details, very aesthetic, vivid, detailed characters`;
    
    const payload = {
      input: finalPrompt,
      model: model,
      action: actionType,
      parameters: {
        width: 832,
        height: 1216,           // 默认生成竖图
        steps: 28,              // 步数，建议 28
        scale: 5.0,             // CFG，建议 5.0
        sampler: "k_euler",     // 采样器
        sm: false,
        sm_dyn: false,
        negative_prompt: "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry"
      }
    };

    // ---------------------------------------------------------
    // 【4. 发起请求并处理官方返回流】
    // ---------------------------------------------------------
    try {
      const naiResponse = await fetch('https://api.novelai.net/ai/generate-image', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NAI_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!naiResponse.ok) {
        const errorText = await naiResponse.text();
        return new Response(`NovelAI 官方接口报错: ${naiResponse.status} - ${errorText}`, { status: naiResponse.status });
      }

      // 获取返回的二进制流 (ZIP 格式)
      const arrayBuffer = await naiResponse.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // 同步解压 ZIP，寻找 PNG
      const unzipped = unzipSync(uint8Array);
      let imageBuffer = null;
      
      for (const [filename, fileData] of Object.entries(unzipped)) {
        if (filename.endsWith('.png')) {
          imageBuffer = fileData;
          break; // 找到第一张图片就退出
        }
      }

      if (!imageBuffer) {
        return new Response('Internal Server Error: 解压成功但在ZIP中未找到PNG文件', { status: 500 });
      }

      // ---------------------------------------------------------
      // 【5. 外部存储 (R2) 异步上传】
      // ---------------------------------------------------------
      // 前提：确保你在 Cloudflare 后台给 Worker 绑定了名为 IMAGE_BUCKET 的 R2 变量
      if (env.IMAGE_BUCKET) {
        // 使用时间戳和随机数生成唯一文件名
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const randomStr = Math.random().toString(36).substring(2, 8);
        const fileName = `nai_${timestamp}_${randomStr}.png`;
        
        // ctx.waitUntil 会让上传在后台静默执行，不会阻塞图片发给浏览器，实现“秒出图”
        ctx.waitUntil(
          env.IMAGE_BUCKET.put(fileName, imageBuffer.buffer, {
            httpMetadata: { contentType: 'image/png' },
            customMetadata: { 
              prompt: prompt, // 将触发词作为元数据存入 R2
              model: model
            } 
          })
        );
      }

      // ---------------------------------------------------------
      // 【6. 返回图片流给浏览器】
      // ---------------------------------------------------------
      return new Response(imageBuffer, {
        headers: {
          'Content-Type': 'image/png',
          // 允许前端直接用 <img> 标签或 fetch 读取，跨域支持
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        }
      });

    } catch (error) {
      return new Response(`Worker 内部错误: ${error.message}`, { status: 500 });
    }
  },
};
