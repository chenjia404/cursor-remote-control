/**
 * 无依赖启动脚本：清旧 SW、登录、把会话交给 app.js 拉项目/历史数据。
 */
(function () {
  var SESSION_KEY = "crc_session_token";
  var CSRF_KEY = "crc_csrf_token";
  var APP_VERSION = "0.4.1";
  var csrfToken = "";
  var sessionToken = "";
  var appLoadPromise = null;

  window.__crcBootManaged = true;

  function $(id) {
    return document.getElementById(id);
  }

  function showToast(message) {
    var toast = $("toast");
    if (!toast) {
      window.alert(message);
      return;
    }
    toast.textContent = message;
    toast.classList.remove("hidden");
    window.setTimeout(function () {
      toast.classList.add("hidden");
    }, 3200);
  }

  function setLoggedIn(loggedIn) {
    var loginView = $("loginView");
    var appView = $("appView");
    var logoutButton = $("logoutButton");
    if (loginView) loginView.classList.toggle("hidden", loggedIn);
    if (appView) appView.classList.toggle("hidden", !loggedIn);
    if (logoutButton) logoutButton.classList.toggle("hidden", !loggedIn);
  }

  function setSubmitting(form, submitting) {
    var button = form.querySelector('button[type="submit"], #loginButton');
    if (button) button.disabled = Boolean(submitting);
  }

  function storageGet(key) {
    try {
      var lasting = localStorage.getItem(key);
      if (lasting) return lasting;
    } catch (_error) {
      // ignore
    }
    try {
      return sessionStorage.getItem(key) || "";
    } catch (_error) {
      return "";
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_error) {
      // ignore
    }
    try {
      sessionStorage.removeItem(key);
    } catch (_error) {
      // ignore
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (_error) {
      // ignore
    }
    try {
      sessionStorage.removeItem(key);
    } catch (_error) {
      // ignore
    }
  }

  function readStoredAuth() {
    sessionToken = storageGet(SESSION_KEY);
    csrfToken = storageGet(CSRF_KEY);
  }

  function persistAuth(session) {
    csrfToken = session.csrfToken || "";
    sessionToken = session.sessionToken || sessionToken || "";
    if (sessionToken) storageSet(SESSION_KEY, sessionToken);
    if (csrfToken) storageSet(CSRF_KEY, csrfToken);
    window.__crcSession = {
      csrfToken: csrfToken,
      sessionToken: sessionToken,
      username: session.username || "",
      role: session.role,
      permissions: session.permissions,
      allowedProjectIds: session.allowedProjectIds,
    };
  }

  function clearAuth() {
    csrfToken = "";
    sessionToken = "";
    window.__crcSession = null;
    storageRemove(SESSION_KEY);
    storageRemove(CSRF_KEY);
  }

  function cleanupOldServiceWorkers() {
    if (!("serviceWorker" in navigator)) return Promise.resolve();
    return navigator.serviceWorker.getRegistrations().then(function (regs) {
      return Promise.all(
        regs.map(function (reg) {
          var scriptURL =
            (reg.active && reg.active.scriptURL) ||
            (reg.waiting && reg.waiting.scriptURL) ||
            (reg.installing && reg.installing.scriptURL) ||
            "";
          // 只清理带版本查询串的旧注册，避免每次清空 Cache 打断模块加载
          if (scriptURL.indexOf("sw.js?") !== -1) {
            return reg.unregister();
          }
          return Promise.resolve();
        }),
      );
    });
  }

  function loadAppModule() {
    if (appLoadPromise) return appLoadPromise;
    appLoadPromise = import("/app.js?v=" + APP_VERSION).catch(function (error) {
      console.error("加载 app.js 失败", error);
      showToast("应用脚本加载失败，请清除站点数据后重试");
      appLoadPromise = null;
      throw error;
    });
    return appLoadPromise;
  }

  function authHeaders(extra) {
    var headers = Object.assign({ "Content-Type": "application/json" }, extra || {});
    if (csrfToken) headers["x-csrf-token"] = csrfToken;
    if (sessionToken) {
      headers.Authorization = "Bearer " + sessionToken;
      headers["x-crc-session"] = sessionToken;
    }
    return headers;
  }

  async function api(path, options) {
    options = options || {};
    var response = await fetch(
      path,
      Object.assign({ credentials: "same-origin" }, options, {
        headers: authHeaders(options.headers),
      }),
    );
    var data = await response.json().catch(function () {
      return {};
    });
    if (!response.ok) {
      throw new Error(data.error || "请求失败");
    }
    return data;
  }

  async function handOffToApp(session) {
    persistAuth(session);
    setLoggedIn(true);

    var app = await loadAppModule();
    var start =
      (app && app.onBootAuthenticated) ||
      (window.__crcApp && window.__crcApp.onBootAuthenticated);

    if (typeof start !== "function") {
      throw new Error("应用模块未导出启动方法");
    }

    await start(window.__crcSession);

    if (!sessionToken) {
      showToast("登录成功，但会话令牌缺失，数据可能无法加载");
    }
  }

  async function restoreSession() {
    readStoredAuth();

    try {
      var session = await api("/api/session");
      var restoredToken = session.sessionToken || sessionToken;
      if (!restoredToken) {
        throw new Error("缺少会话令牌");
      }
      await handOffToApp(Object.assign({}, session, { sessionToken: restoredToken }));
    } catch (_error) {
      if (sessionToken) clearAuth();
      setLoggedIn(false);
      loadAppModule().catch(function () {});
    }
  }

  async function loginWithForm(form) {
    var data = new FormData(form);
    var username = String(data.get("username") || "").trim();
    var password = String(data.get("password") || "");
    if (!username || !password) {
      showToast("请输入用户名和密码");
      return;
    }

    setSubmitting(form, true);
    try {
      // 登录前清掉旧令牌，避免带着失效 Authorization 请求
      clearAuth();
      var session = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ username: username, password: password }),
      });
      if (!session.sessionToken) {
        throw new Error("服务器未返回会话令牌，请重启服务到最新版本");
      }
      await handOffToApp(session);
    } catch (error) {
      console.error("登录后加载失败", error);
      showToast(error && error.message ? error.message : "登录失败");
    } finally {
      setSubmitting(form, false);
    }
  }

  function bindLoginForm() {
    var form = $("loginForm");
    if (!form || form.dataset.bootBound === "1") return;
    form.dataset.bootBound = "1";
    form.addEventListener(
      "submit",
      function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        loginWithForm(form);
      },
      true,
    );
  }

  function bindLogout() {
    var button = $("logoutButton");
    if (!button || button.dataset.bootBound === "1") return;
    button.dataset.bootBound = "1";
    button.addEventListener("click", async function () {
      try {
        await api("/api/logout", { method: "POST", body: "{}" });
      } catch (_error) {
        // ignore
      }
      clearAuth();
      setLoggedIn(false);
    });
  }

  cleanupOldServiceWorkers().finally(function () {
    bindLoginForm();
    bindLogout();
    restoreSession();
  });
})();
