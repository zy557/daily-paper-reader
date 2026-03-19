// 全局密钥会话管理：负责首次进入时的密码解锁 / 游客模式
(function () {
  const STORAGE_KEY_MODE = 'dpr_secret_access_mode_v1'; // 已不再使用，仅保留兼容
  const STORAGE_KEY_PASS = 'dpr_secret_password_v1';
  const SECRET_FILE_URL = 'secret.private';
  const SECRET_OVERLAY_ANIMATION_MS = 280;
  const FORCE_GUEST_DOMAIN_TOKEN = 'ziwenhahaha';
  let secretOverlayHideTimer = null;
  const isForceGuestDomain = (host) => {
    const normalized = String(host || '').toLowerCase();
    return normalized.includes(FORCE_GUEST_DOMAIN_TOKEN);
  };
  const FORCE_GUEST_MODE = isForceGuestDomain(window && window.location && window.location.hostname);

  const setAccessMode = (mode, detail) => {
    window.DPR_ACCESS_MODE = mode;
    try {
      const ev = new CustomEvent('dpr-access-mode-changed', {
        detail: detail || { mode },
      });
      document.dispatchEvent(ev);
    } catch {
      // ignore
    }
  };

  const enforceGuestMode = (overlayEl) => {
    setAccessMode('guest', { mode: 'guest', reason: 'domain_force_guest' });
    if (overlayEl) {
      try {
        overlayEl.classList.remove('show');
        overlayEl.classList.add('secret-gate-hidden');
      } catch {
        // ignore
      }
    }
  };

  const openSecretOverlay = (overlayEl) => {
    if (!overlayEl) return;
    if (secretOverlayHideTimer) {
      clearTimeout(secretOverlayHideTimer);
      secretOverlayHideTimer = null;
    }
    overlayEl.classList.remove('secret-gate-hidden');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlayEl.classList.add('show');
      });
    });
  };

  const closeSecretOverlay = (overlayEl) => {
    if (!overlayEl) return;
    overlayEl.classList.remove('show');
    if (secretOverlayHideTimer) {
      clearTimeout(secretOverlayHideTimer);
    }
    secretOverlayHideTimer = setTimeout(() => {
      overlayEl.classList.add('secret-gate-hidden');
      secretOverlayHideTimer = null;
    }, SECRET_OVERLAY_ANIMATION_MS);
  };

  // 简单的密码强度校验：至少 8 位，包含数字、小写字母、大写字母和特殊符号
  function validatePassword(pwd) {
    if (!pwd || pwd.length < 8) {
      return '密码至少需要 8 位字符。';
    }
    if (!/[0-9]/.test(pwd)) {
      return '密码必须包含数字。';
    }
    if (!/[a-z]/.test(pwd)) {
      return '密码必须包含小写字母。';
    }
    if (!/[A-Z]/.test(pwd)) {
      return '密码必须包含大写字母。';
    }
    if (!/[^A-Za-z0-9]/.test(pwd)) {
      return '密码必须包含至少一个特殊符号（如 !@# 等）。';
    }
    return '';
  }

  // 旧版模式标记已废弃，仅用于清理兼容
  function loadAccessMode() {
    try {
      if (!window.localStorage) return null;
      return window.localStorage.getItem(STORAGE_KEY_MODE);
    } catch {
      return null;
    }
  }

  function loadSavedPassword() {
    try {
      if (!window.localStorage) return '';
      return window.localStorage.getItem(STORAGE_KEY_PASS) || '';
    } catch {
      return '';
    }
  }

  function savePassword(pwd) {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY_PASS, pwd);
    } catch {
      // ignore
    }
  }

  function clearPassword() {
    try {
      if (!window.localStorage) return;
      window.localStorage.removeItem(STORAGE_KEY_PASS);
    } catch {
      // ignore
    }
  }

  // 使用 GitHub Token 推断目标仓库 owner/repo（与订阅面板保持一致的推断规则）
  async function detectGithubRepoFromToken(token) {
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    if (!userRes.ok) {
      throw new Error('无法使用当前 GitHub Token 获取用户信息。');
    }
    const userData = await userRes.json();
    const login = userData.login || '';

    const currentUrl = window.location.href;
    const urlObj = new URL(currentUrl);
    const host = urlObj.hostname || '';

    let repoOwner = '';
    let repoName = '';

    if (host === 'localhost' || host === '127.0.0.1') {
      repoOwner = login;
      repoName = 'daily-paper-reader';
    } else {
      const githubPagesMatch = currentUrl.match(
        /https?:\/\/([^.]+)\.github\.io\/([^\/]+)/,
      );
      if (githubPagesMatch) {
        repoOwner = githubPagesMatch[1];
        repoName = githubPagesMatch[2];
      } else {
        // 其它域名：尝试从 config.yaml 中读取
        try {
          const res = await fetch('/config.yaml');
          if (res.ok) {
            const text = await res.text();
            const yaml =
              window.jsyaml || window.jsYaml || window.jsYAML || window.jsYml;
            if (yaml && typeof yaml.load === 'function') {
              const cfg = yaml.load(text) || {};
              const githubCfg = (cfg && cfg.github) || {};
              if (githubCfg && typeof githubCfg === 'object') {
                if (githubCfg.owner) repoOwner = String(githubCfg.owner);
                if (githubCfg.repo) repoName = String(githubCfg.repo);
              }
            }
          }
        } catch {
          // 忽略 config.yaml 读取失败，后续用兜底逻辑
        }

        if (!repoOwner) {
          repoOwner = login;
        }
      }
    }

    if (!repoOwner || !repoName) {
      throw new Error('无法推断目标仓库，请检查当前访问域名或配置。');
    }

    return { owner: repoOwner, repo: repoName };
  }

  // 将总结大模型 / 重排序模型的配置写入 GitHub Secrets
  // 可选 progress 回调用于在 UI 中展示上传进度：progress(currentIndex, total, secretName)
  async function saveSummarizeSecretsToGithub(
    token,
    summarisedApiKey,
    summarisedModel,
    summarisedRawBaseUrl,
    progress,
  ) {
    try {
      // 等待 libsodium-wrappers 就绪（通过 CDN 注入全局 sodium）
      if (!window.sodium || !window.sodium.ready) {
        if (
          window.sodium &&
          typeof window.sodium.ready === 'object' &&
          typeof window.sodium.ready.then === 'function'
        ) {
          await window.sodium.ready;
        } else {
          throw new Error(
            '浏览器未正确加载 libsodium-wrappers，无法写入 GitHub Secrets。',
          );
        }
      }
      const sodium = window.sodium;
      if (!sodium) {
        throw new Error('浏览器缺少 libsodium 支持，无法写入 GitHub Secrets。');
      }

      const { owner, repo } = await detectGithubRepoFromToken(token);

      // 获取仓库 Public Key
      const pkRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        },
      );
      if (!pkRes.ok) {
        throw new Error(
          `获取仓库 Public Key 失败（HTTP ${pkRes.status}），请确认 Token 是否具备 repo 权限。`,
        );
      }
      const pkData = await pkRes.json();
      const publicKey = pkData.key;
      const keyId = pkData.key_id;
      if (!publicKey || !keyId) {
        throw new Error('Public Key 数据不完整，无法写入 Secrets。');
      }

      const encryptValue = (value) => {
        const binkey = sodium.from_base64(
          publicKey,
          sodium.base64_variants.ORIGINAL,
        );
        const binsec = sodium.from_string(value);
        const encBytes = sodium.crypto_box_seal(binsec, binkey);
        return sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);
      };

      // 根据用户提供的 base URL 推导各端点 URL
      // summarisedRawBaseUrl 为 base URL，例如 https://api.bltcy.ai/v1
      const rawBase = (summarisedRawBaseUrl || 'https://api.bltcy.ai/v1').replace(/\/$/, '');
      // chat completions 端点（用于 Summarized_LLM_BASE_URL）
      const chatBaseUrl = rawBase.endsWith('/chat/completions')
        ? rawBase
        : `${rawBase}/chat/completions`;
      // rerank 端点（用于 Reranker_LLM_BASE_URL）
      const rerankerBaseUrl = rawBase.endsWith('/rerank')
        ? rawBase
        : `${rawBase}/rerank`;
      const rerankerModel = 'qwen3-reranker-4b';

      // 简易配置下写入的 GitHub Secrets 约定：
      // - Summarized_LLM_API_KEY：用户输入的 API Key
      // - Summarized_LLM_BASE_URL：chat completions 完整端点 URL
      // - Summarized_LLM_MODEL：用户选择的总结模型
      // - BLT_API_KEY：兼容旧版流水线，值与 Summarized_LLM_API_KEY 相同
      // - LLM_API_KEY：通用大模型 API Key（优先级高于 BLT_API_KEY）
      // - LLM_BASE_URL：通用大模型 Base URL（不含 /chat/completions）
      // - LLM_MODEL：通用大模型模型名称
      // - Reranker_LLM_API_KEY：与 Summarized_LLM_API_KEY 相同
      // - Reranker_LLM_BASE_URL：rerank 端点 URL
      // - Reranker_LLM_MODEL：默认 qwen3-reranker-4b

      const encSummKey = encryptValue(summarisedApiKey);
      const encSummUrl = encryptValue(chatBaseUrl);
      const encSummModel = encryptValue(summarisedModel);
      const encLlmBaseUrl = encryptValue(rawBase);
      const encRerankKey = encryptValue(summarisedApiKey);
      const encRerankUrl = encryptValue(rerankerBaseUrl);
      const encRerankModel = encryptValue(rerankerModel);

      const putSecret = async (name, encrypted) => {
        const body = {
          encrypted_value: encrypted,
          key_id: keyId,
        };
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(
            name,
          )}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(
            `写入 GitHub Secret ${name} 失败：HTTP ${res.status} ${res.statusText} - ${txt}`,
          );
        }
      };

      const secrets = [
        { name: 'Summarized_LLM_API_KEY', value: encSummKey },
        { name: 'Summarized_LLM_BASE_URL', value: encSummUrl },
        { name: 'Summarized_LLM_MODEL', value: encSummModel },
        { name: 'BLT_API_KEY', value: encSummKey },
        { name: 'LLM_API_KEY', value: encSummKey },
        { name: 'LLM_BASE_URL', value: encLlmBaseUrl },
        { name: 'LLM_MODEL', value: encSummModel },
        { name: 'Reranker_LLM_API_KEY', value: encRerankKey },
        { name: 'Reranker_LLM_BASE_URL', value: encRerankUrl },
        { name: 'Reranker_LLM_MODEL', value: encRerankModel },
      ];

      for (let i = 0; i < secrets.length; i += 1) {
        const item = secrets[i];
        if (typeof progress === 'function') {
          try {
            progress(i + 1, secrets.length, item.name);
          } catch {
            // 忽略进度回调中的异常
          }
        }
        await putSecret(item.name, item.value);
      }

      return true;
    } catch (e) {
      console.error('[SECRET] 保存 GitHub Secrets 失败：', e);
      return false;
    }
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  // 将生成好的 secret.private 提交到当前 GitHub 仓库根目录
  async function saveSecretPrivateToGithubRepo(token, payload) {
    try {
      const { owner, repo } = await detectGithubRepoFromToken(token);
      const filePath = 'secret.private';

      // 先尝试获取现有文件，拿到 sha（如果不存在则忽略 404）
      let existingSha = null;
      try {
        const getRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
            filePath,
          )}`,
          {
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          },
        );
        if (getRes.ok) {
          const info = await getRes.json().catch(() => null);
          if (info && info.sha) {
            existingSha = info.sha;
          }
        } else if (getRes.status !== 404) {
          const txt = await getRes.text().catch(() => '');
          throw new Error(
            `读取远程 secret.private 失败：HTTP ${getRes.status} ${getRes.statusText} - ${txt}`,
          );
        }
      } catch (e) {
        console.error('[SECRET] 预读远程 secret.private 失败：', e);
        throw e;
      }

      const contentJson =
        typeof payload === 'string'
          ? payload
          : JSON.stringify(payload, null, 2);
      const contentB64 = btoa(unescape(encodeURIComponent(contentJson)));
      const body = {
        message: existingSha
          ? 'chore: update secret.private via web setup'
          : 'chore: init secret.private via web setup',
        content: contentB64,
      };
      if (existingSha) {
        body.sha = existingSha;
      }

      const putRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
          filePath,
        )}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (!putRes.ok) {
        const txt = await putRes.text().catch(() => '');
        throw new Error(
          `提交 secret.private 到仓库失败：HTTP ${putRes.status} ${putRes.statusText} - ${txt}`,
        );
      }

      return true;
    } catch (e) {
      console.error('[SECRET] 保存 secret.private 到 GitHub 仓库失败：', e);
      return false;
    }
  }

  async function deriveAesGcmKey(password, saltBytes, usages) {
    const enc = new TextEncoder();
    const cryptoObj = (typeof window !== 'undefined' && (window.crypto || window.msCrypto)) || null;
    if (!cryptoObj || !cryptoObj.subtle) {
      throw new Error(
        '当前环境不支持 Web Crypto AES-GCM。请通过 https 或 http://localhost 使用现代浏览器（Chrome/Edge/Firefox）打开本页面后重试。',
      );
    }
    const baseKey = await cryptoObj.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return cryptoObj.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: 120000,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usages,
    );
  }

  // 约定 secret.private 的结构为：
  // {
  //   "version": 1,
  //   "salt": "<base64>",
  //   "iv": "<base64>",
  //   "ciphertext": "<base64>"
  // }
  // 明文为 JSON 字符串，包含 LLM API Key 等配置信息。
  async function decryptSecret(password, payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('密文格式不正确');
    }
    const saltB64 = payload.salt;
    const ivB64 = payload.iv;
    const cipherB64 = payload.ciphertext;
    if (!saltB64 || !ivB64 || !cipherB64) {
      throw new Error('缺少必须字段（salt/iv/ciphertext）');
    }

    const saltBytes = base64ToBytes(saltB64);
    const ivBytes = base64ToBytes(ivB64);
    const cipherBytes = base64ToBytes(cipherB64);

    const key = await deriveAesGcmKey(password, saltBytes, ['decrypt']);
    const plainBuf = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
      },
      key,
      cipherBytes,
    );
    const dec = new TextDecoder();
    const text = dec.decode(plainBuf);
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error('解密成功但内容不是有效 JSON');
    }
    return obj;
  }

  // 创建新的 secret.private：以明文配置对象 + 密码生成加密文件结构
  async function createEncryptedSecret(password, plainConfig) {
    const enc = new TextEncoder();
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesGcmKey(password, saltBytes, ['encrypt']);

    const plainText = JSON.stringify(plainConfig || {}, null, 2);
    const cipherBuf = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
      },
      key,
      enc.encode(plainText),
    );

    const toB64 = (bytes) => {
      let bin = '';
      const view = new Uint8Array(bytes);
      for (let i = 0; i < view.length; i += 1) {
        bin += String.fromCharCode(view[i]);
      }
      return btoa(bin);
    };

    return {
      version: 1,
      salt: toB64(saltBytes),
      iv: toB64(ivBytes),
      ciphertext: toB64(cipherBuf),
    };
  }

  // 初始化模式：已有 secret.private -> 解锁 / 游客；无 secret.private -> 首次配置向导
  function setupOverlay(hasSecretFile) {
    const overlay = document.getElementById('secret-gate-overlay');
    const modal = document.getElementById('secret-gate-modal');
    if (!overlay || !modal) {
      return;
    }

    const setMode = (mode) => {
      if (FORCE_GUEST_MODE && mode !== 'guest') {
        enforceGuestMode(overlay);
        return;
      }
      setAccessMode(mode);
    };

    const hide = () => {
      closeSecretOverlay(overlay);
    };

    if (overlay && !overlay._secretBound) {
      overlay._secretBound = true;
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) {
          hide();
        }
      });
    }

    // 已有 secret.private 时的解锁界面渲染逻辑
    const renderUnlockUI = () => {
      modal.innerHTML = `
        <h2 style="margin-top:0;">🔐 解锁密钥</h2>
        <p style="font-size:13px; color:#555; margin-bottom:8px;">
          检测到已存在密钥文件 <code>secret.private</code>。请输入解锁密码，
          或选择以游客身份访问（仅支持阅读论文，无法使用后台大模型能力）。
        </p>
        <label for="secret-gate-password" style="font-size:13px; color:#333; display:block; margin-bottom:4px;">
          解锁密码（至少 8 位，包含数字、小写字母、大写字母和特殊符号）：
        </label>
        <input
          id="secret-gate-password"
          type="password"
          autocomplete="off"
          style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:6px; font-size:13px;"
        />
        <div id="secret-gate-error" style="min-height:18px; font-size:12px; color:#999; margin-bottom:8px;">
          密码仅在本地用于解密，不会上传到服务器。
        </div>
        <div class="secret-gate-actions">
          <button id="secret-gate-guest" type="button" class="secret-gate-btn secondary">
            以游客身份访问
          </button>
          <button id="secret-gate-unlock" type="button" class="secret-gate-btn primary">
            解锁密钥
          </button>
        </div>
      `;

      const pwdInput = document.getElementById('secret-gate-password');
      const errorEl = document.getElementById('secret-gate-error');
      const guestBtn = document.getElementById('secret-gate-guest');
      const unlockBtn = document.getElementById('secret-gate-unlock');

      if (!pwdInput || !guestBtn || !unlockBtn) return;

      // 游客模式：不解密，不加载密钥，仅浏览 & 阅读
      guestBtn.addEventListener('click', () => {
        setMode('guest');
        hide();
      });

      unlockBtn.addEventListener('click', async () => {
        const pwd = (pwdInput.value || '').trim();
        const msg = validatePassword(pwd);
        if (msg) {
          if (errorEl) {
            errorEl.textContent = msg;
            errorEl.style.color = '#c00';
          }
          return;
        }
        if (errorEl) {
          errorEl.textContent = '正在解锁密钥，请稍候...';
          errorEl.style.color = '#666';
        }
        unlockBtn.disabled = true;
        guestBtn.disabled = true;
        try {
          const resp = await fetch(SECRET_FILE_URL, { cache: 'no-store' });
          if (!resp.ok) {
            throw new Error(`获取 secret.private 失败，HTTP ${resp.status}`);
          }
          const payload = await resp.json();
          const secret = await decryptSecret(pwd, payload);
          // 将解密后的配置保存在内存中，不落盘，同时记住密码以便下次自动解锁
          window.decoded_secret_private = secret;
          savePassword(pwd);
          setMode('full');
          hide();
        } catch (e) {
          console.error(e);
          if (errorEl) {
            errorEl.textContent =
              '解锁失败，请检查密码是否正确，或稍后重试。';
            errorEl.style.color = '#c00';
          }
        } finally {
          unlockBtn.disabled = false;
          guestBtn.disabled = false;
        }
      });

      setTimeout(() => {
        try {
          pwdInput.focus();
        } catch {
          // ignore
        }
      }, 100);
    };

    // 提供商预设配置
    const PROVIDER_PRESETS = {
      bltcy: {
        label: '柏拉图 (BLTCY) · 推荐',
        baseUrl: 'https://api.bltcy.ai/v1',
        hint: '柏拉图提供多个主流模型的统一接入，适合新用户快速上手。<a href="https://api.bltcy.ai/" target="_blank" rel="noopener">获取 API Key</a>',
        keyLabel: '柏拉图（BLTCY）API Key',
        keyPlaceholder: '例如：sk-xxxx',
        keyHint: '将通过 <code>/v1/token/quota</code> 接口验证可用性。',
        verifyMethod: 'bltcy_quota',
        showPresetModels: true,
        modelSuggestions: '',
      },
      deepseek: {
        label: 'DeepSeek（深度求索）',
        baseUrl: 'https://api.deepseek.com/v1',
        hint: '深度求索 DeepSeek 官方 API，支持 deepseek-chat（V3）、deepseek-reasoner（R1）等模型。<a href="https://platform.deepseek.com/" target="_blank" rel="noopener">获取 API Key</a>',
        keyLabel: 'DeepSeek API Key',
        keyPlaceholder: '例如：sk-xxxx',
        keyHint: '将通过 <code>/v1/models</code> 接口验证可用性。',
        verifyMethod: 'models_list',
        showPresetModels: false,
        modelSuggestions: '常用模型：deepseek-chat（DeepSeek V3）、deepseek-reasoner（DeepSeek R1）',
      },
      openai: {
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        hint: 'OpenAI 官方 API，支持 GPT-4o、o1 系列等模型。<a href="https://platform.openai.com/" target="_blank" rel="noopener">获取 API Key</a>',
        keyLabel: 'OpenAI API Key',
        keyPlaceholder: '例如：sk-xxxx',
        keyHint: '将通过 <code>/v1/models</code> 接口验证可用性。',
        verifyMethod: 'models_list',
        showPresetModels: false,
        modelSuggestions: '常用模型：gpt-4o、gpt-4o-mini、o1、o3-mini',
      },
      siliconflow: {
        label: 'SiliconFlow（硅基流动）',
        baseUrl: 'https://api.siliconflow.cn/v1',
        hint: '硅基流动 API，国内访问稳定，支持 DeepSeek、Qwen 等主流开源模型。<a href="https://siliconflow.cn/" target="_blank" rel="noopener">获取 API Key</a>',
        keyLabel: 'SiliconFlow API Key',
        keyPlaceholder: '例如：sk-xxxx',
        keyHint: '将通过 <code>/v1/models</code> 接口验证可用性。',
        verifyMethod: 'models_list',
        showPresetModels: false,
        modelSuggestions: '常用模型：deepseek-ai/DeepSeek-V3、Qwen/Qwen2.5-72B-Instruct、deepseek-ai/DeepSeek-R1',
      },
      custom: {
        label: '自定义（Custom）',
        baseUrl: '',
        hint: '输入任意 OpenAI 兼容 API 的 Base URL（例如本地 Ollama、其他代理或中转服务）。',
        keyLabel: 'API Key',
        keyPlaceholder: '例如：sk-xxxx（无密钥服务可留空）',
        keyHint: '请确保 API Key 与 Base URL 匹配；自定义提供商跳过自动验证，无需密钥的服务（如本地 Ollama）可留空。',
        verifyMethod: 'none',
        showPresetModels: false,
        modelSuggestions: '请输入该提供商支持的模型名称，例如：llama3、mistral、qwen2.5:72b',
      },
    };

    // 初始化向导：第 2 步（简易 / 进阶配置，目前仅实现简易配置）
    const renderInitStep2 = (password) => {
      modal.innerHTML = `
        <h2 style="margin-top:0;">🛡️ 新配置指引 · 第二步</h2>
        <p style="font-size:13px; color:#555; margin-bottom:8px;">
          请选择配置模式，并填写必要的密钥信息。当前版本推荐使用「简易配置」，
          后续可以在订阅面板中进一步管理详细配置。
        </p>
        <div style="margin-bottom:10px; font-size:13px;">
          <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
            <input type="radio" name="secret-setup-mode" value="simple" checked />
            <span><strong>简易配置（推荐）</strong>：填写 GitHub Token 与大模型 API Key，即可启用订阅与论文总结能力。</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; color:#aaa;">
            <input type="radio" name="secret-setup-mode" value="advanced" disabled />
            <span>进阶配置（预留）：将来支持更多细粒度选项，当前暂未开放。</span>
          </label>
        </div>
        <div style="border-top:1px solid #eee; padding-top:8px; margin-top:4px; font-size:13px;">
          <div style="font-weight:500; margin-bottom:4px;">GitHub Token（必填）</div>
          <input
            id="secret-setup-github-token"
            type="password"
            autocomplete="off"
            placeholder="用于读写 config.yaml 的 GitHub Personal Access Token"
            style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:4px; font-size:13px;"
          />
          <button id="secret-setup-github-verify" type="button" class="secret-gate-btn secondary" style="margin-bottom:4px;">
            验证 GitHub Token
          </button>
          <div id="secret-setup-github-status" style="min-height:18px; font-size:12px; color:#999; margin-bottom:8px;">
            需要具备 <code>repo</code> 和 <code>workflow</code> 权限。
          </div>

          <div style="font-weight:500; margin-bottom:4px;">模型提供商（必填）</div>
          <select
            id="secret-setup-provider"
            style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:4px; font-size:13px; background:#fff; border:1px solid #ccc; border-radius:3px;"
          >
            <option value="bltcy">柏拉图 (BLTCY) · 推荐</option>
            <option value="deepseek">DeepSeek（深度求索）</option>
            <option value="openai">OpenAI</option>
            <option value="siliconflow">SiliconFlow（硅基流动）</option>
            <option value="custom">自定义（Custom）</option>
          </select>
          <div id="secret-setup-provider-hint" style="font-size:12px; color:#888; margin-bottom:8px;">
            柏拉图提供多个主流模型的统一接入，适合新用户快速上手。<a href="https://api.bltcy.ai/" target="_blank" rel="noopener">获取 API Key</a>
          </div>

          <div style="font-weight:500; margin-bottom:4px;">API Base URL</div>
          <input
            id="secret-setup-base-url"
            type="text"
            autocomplete="off"
            value="https://api.bltcy.ai/v1"
            placeholder="https://api.example.com/v1"
            style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:8px; font-size:13px;"
          />

          <div style="font-weight:500; margin-bottom:4px;" id="secret-setup-api-key-label">柏拉图（BLTCY）API Key（必填）</div>
          <input
            id="secret-setup-api-key"
            type="password"
            autocomplete="off"
            placeholder="例如：sk-xxxx"
            style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:4px; font-size:13px;"
          />
          <button id="secret-setup-api-key-verify" type="button" class="secret-gate-btn secondary" style="margin-bottom:4px;">
            验证 API Key
          </button>
          <div id="secret-setup-api-key-status" style="min-height:18px; font-size:12px; color:#999; margin-bottom:8px;">
            将通过 <code>/v1/token/quota</code> 接口验证可用性。
          </div>

          <div style="font-weight:500; margin-bottom:4px; display:flex; align-items:center; gap:4px;">
            用于「总结整篇论文」的大模型
            <span class="secret-model-tip">!
              <span class="secret-model-tip-popup">
                按照 Thinking（思考模式）的高负载场景估算：<br/>
                <br/>
                总结：15k 输入 + 4k 输出（含思考）<br/>
                提问：16.1k 输入 + 2k 输出（含思考）<br/>
                <br/>
                柏拉图模型 · 约价（单次）：<br/>
                - Gemini 3 Flash：总结 ¥0.0195，提问 ¥0.0141（不到 2 分钱，100 篇论文约 2 元）<br/>
                - DeepSeek V3：总结 ¥0.0294，提问 ¥0.0267（不到 3 分钱，长输出性价比极高）<br/>
                - GPT-5：总结 ¥0.0588，提问 ¥0.0401（约 6 分钱）<br/>
                - Gemini 3 Pro：总结 ¥0.0780，提问 ¥0.0562（约 8 分钱，一篇论文不到 1 毛钱）
              </span>
            </span>
          </div>
          <!-- 柏拉图预设模型（provider=bltcy 时显示） -->
          <div id="secret-setup-model-presets" style="font-size:13px; margin-bottom:6px;">
            <label style="display:flex; align-items:center; gap:6px; margin-bottom:2px;">
              <input type="radio" name="secret-setup-summarize-model" value="gemini-3-flash-preview-thinking-1000" checked />
              <span>Gemini 3 Flash（思考版，推荐）</span>
            </label>
            <label style="display:flex; align-items:center; gap:6px; margin-bottom:2px;">
              <input type="radio" name="secret-setup-summarize-model" value="deepseek-v3.2" />
              <span>DeepSeek V3.2 · 深度思考</span>
            </label>
            <label style="display:flex; align-items:center; gap:6px; margin-bottom:2px;">
              <input type="radio" name="secret-setup-summarize-model" value="gpt-5-chat" />
              <span>GPT-5 Chat · 通用高质量对话</span>
            </label>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="radio" name="secret-setup-summarize-model" value="gemini-3-pro-preview" />
              <span>Gemini 3 Pro（更强思考能力）</span>
            </label>
          </div>
          <!-- 自定义模型名称输入（provider != bltcy 时显示） -->
          <div id="secret-setup-model-custom-section" style="display:none; font-size:13px; margin-bottom:6px;">
            <input
              id="secret-setup-model-custom-input"
              type="text"
              autocomplete="off"
              placeholder="输入模型名称，例如：gpt-4o"
              style="width:100%; box-sizing:border-box; padding:6px 8px; font-size:13px;"
            />
            <div id="secret-setup-model-suggestions" style="font-size:12px; color:#888; margin-top:4px;"></div>
          </div>
        </div>

        <div id="secret-setup-error" style="min-height:18px; font-size:12px; color:#999; margin-top:4px; margin-bottom:8px;">
          所有密钥信息将加密写入 GitHub Secrets（用于 GitHub Actions），并同步生成本地 <code>secret.private</code> 备份，原文不会直接存入仓库。
        </div>
        <div class="secret-gate-actions">
          <button id="secret-setup-back" type="button" class="secret-gate-btn secondary">
            上一步
          </button>
          <button id="secret-setup-close" type="button" class="secret-gate-btn secondary">
            关闭
          </button>
          <button id="secret-setup-generate" type="button" class="secret-gate-btn primary">
            保存配置
          </button>
        </div>
      `;

      const githubInput = document.getElementById('secret-setup-github-token');
      const githubVerifyBtn = document.getElementById(
        'secret-setup-github-verify',
      );
      const githubStatusEl = document.getElementById(
        'secret-setup-github-status',
      );
      const providerSelect = document.getElementById('secret-setup-provider');
      const providerHintEl = document.getElementById('secret-setup-provider-hint');
      const baseUrlInput = document.getElementById('secret-setup-base-url');
      const apiKeyLabelEl = document.getElementById('secret-setup-api-key-label');
      const apiKeyInput = document.getElementById('secret-setup-api-key');
      const apiKeyVerifyBtn = document.getElementById('secret-setup-api-key-verify');
      const apiKeyStatusEl = document.getElementById('secret-setup-api-key-status');
      const modelPresetsEl = document.getElementById('secret-setup-model-presets');
      const modelCustomSectionEl = document.getElementById('secret-setup-model-custom-section');
      const modelCustomInput = document.getElementById('secret-setup-model-custom-input');
      const modelSuggestionsEl = document.getElementById('secret-setup-model-suggestions');
      const errorEl = document.getElementById('secret-setup-error');
      const backBtn = document.getElementById('secret-setup-back');
      const closeBtn = document.getElementById('secret-setup-close');
      const genBtn = document.getElementById('secret-setup-generate');

      if (!githubInput || !githubVerifyBtn || !providerSelect || !apiKeyInput || !apiKeyVerifyBtn || !backBtn || !closeBtn || !genBtn) return;

      let githubOk = false;
      let apiKeyOk = false;

      // 根据当前提供商更新 UI 的辅助函数
      const applyProviderPreset = (providerKey) => {
        const preset = PROVIDER_PRESETS[providerKey] || PROVIDER_PRESETS.bltcy;
        if (providerHintEl) providerHintEl.innerHTML = preset.hint;
        if (baseUrlInput && providerKey !== 'custom') {
          baseUrlInput.value = preset.baseUrl;
        } else if (baseUrlInput && providerKey === 'custom') {
          baseUrlInput.value = '';
        }
        if (apiKeyLabelEl) apiKeyLabelEl.textContent = providerKey === 'custom' ? `${preset.keyLabel}（选填）` : `${preset.keyLabel}（必填）`;
        if (apiKeyInput) apiKeyInput.placeholder = preset.keyPlaceholder;
        if (apiKeyStatusEl) apiKeyStatusEl.innerHTML = preset.keyHint;
        if (modelPresetsEl) modelPresetsEl.style.display = preset.showPresetModels ? '' : 'none';
        if (modelCustomSectionEl) modelCustomSectionEl.style.display = preset.showPresetModels ? 'none' : '';
        if (modelSuggestionsEl) modelSuggestionsEl.textContent = preset.modelSuggestions || '';
        // 重置 API key 验证状态
        apiKeyOk = false;
      };

      backBtn.addEventListener('click', () => {
        // 返回第 1 步，重新设置密码
        renderInitStep1();
      });

      closeBtn.addEventListener('click', () => {
        // 直接关闭弹窗
        hide();
      });

      // 提供商切换事件
      providerSelect.addEventListener('change', () => {
        applyProviderPreset(providerSelect.value);
      });

      githubVerifyBtn.addEventListener('click', async () => {
        const token = githubInput.value.trim();
        if (!token) {
          githubStatusEl.textContent = '请先输入 GitHub Token。';
          githubStatusEl.style.color = '#c00';
          githubOk = false;
          return;
        }
        githubVerifyBtn.disabled = true;
        githubStatusEl.textContent = '正在验证 GitHub Token...';
        githubStatusEl.style.color = '#666';
        try {
          const res = await fetch('https://api.github.com/user', {
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const scopesHeader = res.headers.get('X-OAuth-Scopes') || '';
          const scopeList = scopesHeader
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const requiredScopes = ['repo', 'workflow'];
          const missing = requiredScopes.filter(
            (s) => !scopeList.includes(s),
          );
          if (missing.length) {
            throw new Error(
              `Token 权限不足，缺少：${missing.join(
                ', ',
              )}。请在 GitHub 中重新生成 PAT。`,
            );
          }
          const userData = await res.json().catch(() => ({}));
          githubStatusEl.innerHTML = `✅ 验证成功：用户 ${userData.login || ''}，权限：${scopeList.join(', ')}`;
          githubStatusEl.style.color = '#28a745';
          githubOk = true;
        } catch (e) {
          githubStatusEl.textContent = `❌ 验证失败：${e.message || e}`;
          githubStatusEl.style.color = '#c00';
          githubOk = false;
        } finally {
          githubVerifyBtn.disabled = false;
        }
      });

      apiKeyVerifyBtn.addEventListener('click', async () => {
        const key = apiKeyInput.value.trim();
        const providerKey = providerSelect.value;
        const preset = PROVIDER_PRESETS[providerKey] || PROVIDER_PRESETS.bltcy;
        const rawBase = (baseUrlInput.value || preset.baseUrl || '').trim().replace(/\/$/, '');

        if (!key) {
          apiKeyStatusEl.textContent = '请先输入 API Key。';
          apiKeyStatusEl.style.color = '#c00';
          apiKeyOk = false;
          return;
        }

        if (preset.verifyMethod === 'none') {
          apiKeyStatusEl.textContent = '✅ 自定义提供商跳过验证，请确保 API Key 与 Base URL 正确。';
          apiKeyStatusEl.style.color = '#888';
          apiKeyOk = true;
          return;
        }

        apiKeyVerifyBtn.disabled = true;
        apiKeyStatusEl.textContent = '正在验证 API Key...';
        apiKeyStatusEl.style.color = '#666';
        try {
          if (preset.verifyMethod === 'bltcy_quota') {
            // 柏拉图：通过 /v1/token/quota 验证
            const resp = await fetch(
              `${rawBase}/token/quota`,
              {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${key}`,
                },
              },
            );
            if (!resp.ok) {
              throw new Error(`HTTP ${resp.status}`);
            }
            const data = await resp.json().catch(() => null);
            const quota =
              data && typeof data.quota === 'number' ? data.quota : 0;
            const used = -quota;
            apiKeyStatusEl.textContent = `✅ 验证成功：已用额度约 ${used.toFixed(2)}`;
            apiKeyStatusEl.style.color = '#28a745';
            apiKeyOk = true;
          } else {
            // 通用：通过 /models 端点验证
            const resp = await fetch(
              `${rawBase}/models`,
              {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${key}`,
                  Accept: 'application/json',
                },
              },
            );
            if (!resp.ok) {
              throw new Error(`HTTP ${resp.status}`);
            }
            const data = await resp.json().catch(() => null);
            const modelCount = data && Array.isArray(data.data) ? data.data.length : 0;
            apiKeyStatusEl.textContent = `✅ 验证成功${modelCount > 0 ? `：发现 ${modelCount} 个可用模型` : ''}`;
            apiKeyStatusEl.style.color = '#28a745';
            apiKeyOk = true;
          }
        } catch (e) {
          apiKeyStatusEl.textContent = `❌ 验证失败：${e.message || e}`;
          apiKeyStatusEl.style.color = '#c00';
          apiKeyOk = false;
        } finally {
          apiKeyVerifyBtn.disabled = false;
        }
      });

      genBtn.addEventListener('click', async () => {
        const githubToken = githubInput.value.trim();
        const apiKey = apiKeyInput.value.trim();
        const providerKey = providerSelect.value;
        const preset = PROVIDER_PRESETS[providerKey] || PROVIDER_PRESETS.bltcy;
        const rawBase = (baseUrlInput.value || preset.baseUrl || '').trim().replace(/\/$/, '');

        const modeInputs = document.querySelectorAll(
          'input[name="secret-setup-mode"]',
        );
        let mode = 'simple';
        modeInputs.forEach((el) => {
          if (el.checked) mode = el.value;
        });
        if (mode !== 'simple') {
          if (errorEl) {
            errorEl.textContent = '当前仅支持简易配置，请选择简易配置继续。';
            errorEl.style.color = '#c00';
          }
          return;
        }
        if (!githubToken || !githubOk) {
          if (errorEl) {
            errorEl.textContent = '请先填写并通过验证 GitHub Token。';
            errorEl.style.color = '#c00';
          }
          return;
        }
        if (!apiKey && providerKey !== 'custom') {
          if (errorEl) {
            errorEl.textContent = '请先填写 API Key。';
            errorEl.style.color = '#c00';
          }
          return;
        }
        if (providerKey === 'bltcy' && !apiKeyOk) {
          if (errorEl) {
            errorEl.textContent = '请先通过验证柏拉图 API Key。';
            errorEl.style.color = '#c00';
          }
          return;
        }
        // 对于非 BLTCY 的有验证方法的提供商，建议但不强制验证
        if (providerKey !== 'bltcy' && providerKey !== 'custom' && !apiKeyOk && apiKey && errorEl) {
          // 提示但继续
          errorEl.textContent = '⚠️ API Key 未经验证，请确认 API Key 与 Base URL 正确后保存。';
          errorEl.style.color = '#e67e00';
        }
        if (!rawBase) {
          if (errorEl) {
            errorEl.textContent = '请填写 API Base URL。';
            errorEl.style.color = '#c00';
          }
          return;
        }

        // 获取所选模型名称
        let model = '';
        if (preset.showPresetModels) {
          const modelInputs = document.querySelectorAll(
            'input[name="secret-setup-summarize-model"]',
          );
          modelInputs.forEach((el) => {
            if (el.checked) model = el.value;
          });
        } else {
          model = (modelCustomInput && modelCustomInput.value.trim()) || '';
        }
        if (!model) {
          if (errorEl) {
            errorEl.textContent = '请选择或输入用于总结论文的大模型名称。';
            errorEl.style.color = '#c00';
          }
          return;
        }

        const createdAt = new Date().toISOString();
        // 构造 chat completions 完整端点 URL（用于 plainConfig）
        const chatBaseUrl = rawBase.endsWith('/chat/completions')
          ? rawBase
          : `${rawBase}/chat/completions`;
        const rerankerBaseUrl = rawBase.endsWith('/rerank')
          ? rawBase
          : `${rawBase}/rerank`;
        const rerankerModel = 'qwen3-reranker-4b';

        const plainConfig = {
          createdAt,
          github: {
            token: githubToken,
          },
          summarizedLLM: {
            apiKey,
            baseUrl: chatBaseUrl,
            model,
          },
          rerankerLLM: {
            apiKey,
            baseUrl: rerankerBaseUrl,
            model: rerankerModel,
          },
          chatLLMs: [
            {
              apiKey,
              baseUrl: chatBaseUrl,
              models: preset.showPresetModels
                ? [
                    'gemini-3-flash-preview-thinking-1000',
                    'deepseek-v3.2',
                    'gpt-5-chat',
                    'gemini-3-pro-preview-thinking-1000',
                  ]
                : [model],
            },
          ],
        };

        try {
          if (errorEl) {
            errorEl.textContent = '正在准备写入 GitHub Secrets...';
            errorEl.style.color = '#666';
          }
          genBtn.disabled = true;

          // 1) 将总结大模型相关配置写入 GitHub Secrets（失败则中止后续流程）
          const secretsOk = await saveSummarizeSecretsToGithub(
            githubToken,
            apiKey,
            model,
            rawBase,
            (current, total, secretName) => {
              if (!errorEl) return;
              errorEl.textContent = `(${current}/${total}) 正在上传 GitHub Secret：${secretName}...`;
              errorEl.style.color = '#666';
            },
          );
          if (!secretsOk && errorEl) {
            errorEl.textContent =
              '❌ 写入 GitHub Secrets 失败，请检查网络、Token 权限（需 repo + workflow）或稍后重试。';
            errorEl.style.color = '#c00';
            return;
          }

          // 2) 生成本地 secret.private 备份
          if (errorEl) {
            errorEl.textContent = 'GitHub Secrets 上传完成，正在生成加密配置 secret.private...';
            errorEl.style.color = '#666';
          }
          const payload = await createEncryptedSecret(password, plainConfig);
          window.decoded_secret_private = plainConfig;
          setMode('full');

          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'secret.private';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 0);

          // 3) 将 secret.private 提交到 GitHub 仓库根目录（最好由向导自动推送一份）
          if (errorEl) {
            errorEl.textContent = '正在将 secret.private 推送到 GitHub 仓库根目录...';
            errorEl.style.color = '#666';
          }
          const commitOk = await saveSecretPrivateToGithubRepo(
            githubToken,
            payload,
          );
          if (!commitOk && errorEl) {
            errorEl.textContent =
              '⚠️ 已生成本地 secret.private，但自动推送到 GitHub 仓库失败，请稍后手动提交或检查 Token/网络。';
            errorEl.style.color = '#c00';
          }

          hide();

          // 第三步：自动打开后台订阅面板，帮助用户完成 GitHub 订阅配置
          try {
            if (window.SubscriptionsManager && window.SubscriptionsManager.openOverlay) {
              window.SubscriptionsManager.openOverlay();
            } else {
              // 回退：使用与左下角 📚 按钮相同的事件机制唤起订阅面板
              var ensureEvent = new CustomEvent('ensure-arxiv-ui');
              document.dispatchEvent(ensureEvent);
              setTimeout(function () {
                var loadEvent = new CustomEvent('load-arxiv-subscriptions');
                document.dispatchEvent(loadEvent);
                var overlay = document.getElementById('arxiv-search-overlay');
                if (overlay) {
                  overlay.style.display = 'flex';
                  requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                      overlay.classList.add('show');
                    });
                  });
                }
              }, 120);
            }
          } catch {
            // 若后台订阅面板唤起失败，则静默忽略，不影响主流程
          }
        } catch (e) {
          console.error(e);
          if (errorEl) {
            errorEl.textContent =
              '生成 secret.private 失败，请稍后重试或检查浏览器兼容性。';
            errorEl.style.color = '#c00';
          }
        } finally {
          genBtn.disabled = false;
        }
      });
    };

    // 初始化向导：第 1 步（设置密码）
    const renderInitStep1 = () => {
      modal.innerHTML = `
        <h2 style="margin-top:0;">🛡️ 新配置指引 · 第一步</h2>
        <p style="font-size:13px; color:#555; margin-bottom:8px;">
          检测到当前仓库尚未创建 <code>secret.private</code> 文件。
          请先设置一个用于加密本地配置的密码，该密码将用于解锁大模型密钥等敏感信息。
        </p>
        <label for="secret-setup-password" style="font-size:13px; color:#333; display:block; margin-bottom:4px;">
          设置解锁密码：
        </label>
        <input
          id="secret-setup-password"
          type="password"
          autocomplete="off"
          style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:4px; font-size:13px;"
        />
        <input
          id="secret-setup-password-confirm"
          type="password"
          autocomplete="off"
          placeholder="再次输入密码确认"
          style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:6px; font-size:13px;"
        />
        <div id="secret-setup-error" style="min-height:18px; font-size:12px; color:#666; margin-bottom:8px;">
          密码至少 8 位，且必须包含数字、小写字母、大写字母和特殊符号。密码仅保存在浏览器本地，用于解锁密钥。
        </div>
        <div class="secret-gate-actions">
          <button id="secret-setup-guest" type="button" class="secret-gate-btn secondary">
            以游客身份访问
          </button>
          <button id="secret-setup-next" type="button" class="secret-gate-btn primary">
            下一步
          </button>
        </div>
      `;

      const pwdInput = document.getElementById('secret-setup-password');
      const pwdConfirmInput = document.getElementById(
        'secret-setup-password-confirm',
      );
      const errorEl = document.getElementById('secret-setup-error');
      const guestBtn = document.getElementById('secret-setup-guest');
      const nextBtn = document.getElementById('secret-setup-next');

      if (!pwdInput || !pwdConfirmInput || !guestBtn || !nextBtn) return;

      guestBtn.addEventListener('click', () => {
        setMode('guest');
        hide();
      });

      nextBtn.addEventListener('click', () => {
        const pwd = (pwdInput.value || '').trim();
        const pwd2 = (pwdConfirmInput.value || '').trim();
        const msg = validatePassword(pwd);
        if (msg) {
          if (errorEl) {
            errorEl.textContent = msg;
            errorEl.style.color = '#c00';
          }
          return;
        }
        if (pwd !== pwd2) {
          if (errorEl) {
            errorEl.textContent = '两次输入的密码不一致，请重新确认。';
            errorEl.style.color = '#c00';
          }
          return;
        }

        // 正式进入第 2 步
        renderInitStep2(pwd);
      });

      setTimeout(() => {
        try {
          pwdInput.focus();
        } catch {
          // ignore
        }
      }, 100);
    };

    // 统一渲染两种模式的 UI（仅使用新的两步初始化向导 / 解锁界面）
    // 同时在此处挂钩后台管理面板的“密钥配置”按钮入口，利用当前闭包中的 renderInitStep1/renderInitStep2
    try {
      window.DPRSecretSetup = window.DPRSecretSetup || {};
      window.DPRSecretSetup.openStep2 = function () {
        const savedPwd = loadSavedPassword();
        openSecretOverlay(overlay);
        // 确保浮层可见
        if (!savedPwd) {
          // 没有保存密码：从第 1 步开始完整向导
          renderInitStep1();
        } else {
          // 已保存密码：直接进入第 2 步配置向导
          renderInitStep2(savedPwd);
        }
      };
    } catch {
      // 忽略挂钩失败，后台按钮会走自身的降级提示
    }

    if (hasSecretFile) {
      // 已有 secret.private：展示“解锁 / 游客”界面
      renderUnlockUI();
    } else {
      // 不存在 secret.private：进入初始化两步向导
      renderInitStep1();
    }
  }

  function init() {
    const overlay = document.getElementById('secret-gate-overlay');
    const registerGuestOnlySecretSetup = () => {
      window.DPRSecretSetup = window.DPRSecretSetup || {};
      window.DPRSecretSetup.openStep2 = function () {
        enforceGuestMode(document.getElementById('secret-gate-overlay'));
        alert('当前域名已启用游客模式，不支持解锁密码与密钥配置。');
      };
    };

    // 默认视为锁定状态，直到用户选择“解锁 / 游客”
    window.DPR_ACCESS_MODE = FORCE_GUEST_MODE ? 'guest' : 'locked';

    if (FORCE_GUEST_MODE) {
      setAccessMode('guest', { mode: 'guest', reason: 'domain_force_guest' });
      registerGuestOnlySecretSetup();
      enforceGuestMode(overlay);
      return;
    }

    if (!overlay) return;

    // 检查是否已经存在 secret.private（用于区分“解锁”与“初始化”）
    (async () => {
      try {
        const resp = await fetch(SECRET_FILE_URL, {
          method: 'GET',
          cache: 'no-store',
        });
        let hasSecret = false;
        if (resp.ok) {
          try {
            // 不再依赖 content-type，只要能成功解析为 JSON，就认为是合法的 secret.private
            await resp.clone().json();
            hasSecret = true;
          } catch {
            hasSecret = false;
          }
        }

        window.DPR_ACCESS_MODE = 'locked';

        if (hasSecret) {
          // 已存在 secret.private：若浏览器保存了密码，先尝试自动解锁；
          // 成功则直接进入页面；失败或无密码则展示解锁/游客界面。
          const savedPwd = loadSavedPassword();
          if (savedPwd) {
            try {
              const resp2 = await fetch(SECRET_FILE_URL, {
                cache: 'no-store',
              });
              if (!resp2.ok) {
                throw new Error(
                  `获取 secret.private 失败，HTTP ${resp2.status}`,
                );
              }
              const payload = await resp2.json();
              const secret = await decryptSecret(savedPwd, payload);
              window.decoded_secret_private = secret;
              // 这里不在 setupOverlay 作用域内，直接标记全局访问模式为 full 并广播事件
              try {
                setAccessMode('full', { mode: 'full' });
              } catch {
                // ignore
              }
              // 自动解锁成功时，仍然初始化一次 overlay，以便后台“密钥配置”按钮可以直接打开第二步向导
              // 注意：此时不移除 hidden 类，浮层保持隐藏，仅注册 DPRSecretSetup.openStep2 等入口
              try {
                setupOverlay(true);
              } catch {
                // ignore
              }
              closeSecretOverlay(overlay);
              return;
            } catch (e) {
              console.error(
                '[SECRET] 自动解锁失败，将回退到手动输入密码界面：',
                e,
              );
              clearPassword();
            }
          }
          // 没有保存的密码或自动解锁失败：展示解锁/游客界面
          setupOverlay(true);
          openSecretOverlay(overlay);
        } else {
          // 不存在 secret.private：始终展示初始化向导
          setupOverlay(false);
          openSecretOverlay(overlay);
        }
      } catch {
        // 请求失败时按“文件不存在”处理：始终进入初始化向导
        window.DPR_ACCESS_MODE = 'locked';
        setupOverlay(false);
        openSecretOverlay(overlay);
      }
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
