export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    if (requestUrl.protocol === "http:") {
      requestUrl.protocol = "https:";
      return Response.redirect(requestUrl, 308);
    }

    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return response;
    }

    const appShellUrl = new URL(request.url);
    appShellUrl.pathname = "/";
    appShellUrl.search = "";
    return env.ASSETS.fetch(new Request(appShellUrl, request));
  },
};
