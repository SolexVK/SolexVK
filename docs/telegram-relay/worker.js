// Ретранслятор Telegram Bot API для Cloudflare Workers.
// Пересылает запросы вида https://<ваш-worker>/bot<token>/<method> на api.telegram.org.
// Переменная RELAY_KEY (секрет в настройках Worker) закрывает ретранслятор от чужих.

export default {
  async fetch(request, env) {
    if (env.RELAY_KEY && request.headers.get("x-relay-key") !== env.RELAY_KEY) {
      return new Response("forbidden", { status: 403 });
    }
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/bot")) {
      return new Response("not found", { status: 404 });
    }
    const target = "https://api.telegram.org" + url.pathname + url.search;
    const init = {
      method: request.method,
      headers: { "content-type": request.headers.get("content-type") || "application/json" },
    };
    if (request.method === "POST") {
      init.body = await request.text();
    }
    const upstream = await fetch(target, init);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
    });
  },
};
