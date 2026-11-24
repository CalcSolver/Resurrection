self.__uv$config = {
  prefix: "/24/54/",
  encodeUrl: (str) => {
    if (!str) return str;
    return encodeURIComponent(
      str
        .split("")
        .map((char, idx) =>
          idx % 2 ? String.fromCharCode(char.charCodeAt(0) ^ 54) : char
        )
        .join("")
    );
  },
  decodeUrl: (str) => {
    if (!str) return str;
    const decoded = decodeURIComponent(str);
    return decoded
      .split("")
      .map((char, idx) =>
        idx % 2 ? String.fromCharCode(char.charCodeAt(0) ^ 54) : char
      )
      .join("");
  },
  handler: "/uv/uv.handler.js",
  client: "/uv/uv.client.js",
  bundle: "/uv/uv.bundle.js",
  config: "/uv.config.js",
  sw: "/uv/uv.sw.js"
};
