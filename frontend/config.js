/* Where the chat backend lives.
   - Local run (python -m uvicorn ...): the page and API share an origin, so apiBase stays "".
   - GitHub Pages: the page is static, so it calls the backend hosted on Render.
     Replace the URL below with your Render service URL if it differs. */
window.CHATBOT_CONFIG = {
  apiBase: location.hostname.endsWith("github.io")
    ? "https://chatboot-api.onrender.com"
    : "",
};
