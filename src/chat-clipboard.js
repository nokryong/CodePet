// 클립보드의 이미지 File을 IPC로 전달할 수 있는 plain payload로 바꿉니다.
// 브라우저와 Node 테스트에서 함께 쓰기 위해 작은 UMD 모듈로 유지합니다.
(function attachChatClipboard(global) {
  const MAX_PASTED_IMAGES = 10;
  const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

  function imageExtension(mime) {
    const extensions = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/bmp": "bmp",
    };
    return extensions[String(mime || "").toLowerCase()] || "bin";
  }

  function clipboardImageFiles(clipboardData) {
    const itemFiles = [];
    for (const item of Array.from(clipboardData?.items || [])) {
      if (item?.kind !== "file" || !String(item.type || "").toLowerCase().startsWith("image/")) {
        continue;
      }
      const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
      if (file) itemFiles.push(file);
    }
    if (itemFiles.length > 0) return itemFiles.slice(0, MAX_PASTED_IMAGES);

    return Array.from(clipboardData?.files || [])
      .filter((file) => String(file?.type || "").toLowerCase().startsWith("image/"))
      .slice(0, MAX_PASTED_IMAGES);
  }

  async function serializeClipboardImages(files, options = {}) {
    const maxFileBytes = options.maxFileBytes || MAX_PASTED_IMAGE_BYTES;
    const timestamp = typeof options.now === "function" ? options.now() : Date.now();
    const images = [];
    const errors = [];

    for (const [index, file] of Array.from(files || []).slice(0, MAX_PASTED_IMAGES).entries()) {
      const mime = String(file?.type || "").toLowerCase();
      const fallbackName = `붙여넣은-이미지-${timestamp}-${index + 1}.${imageExtension(mime)}`;
      const name = String(file?.name || "").trim() || fallbackName;
      const declaredSize = Number(file?.size);
      if (Number.isFinite(declaredSize) && declaredSize > maxFileBytes) {
        errors.push({ name, error: `이미지가 너무 큽니다. (최대 ${Math.floor(maxFileBytes / 1024 / 1024)}MiB)` });
        continue;
      }

      try {
        if (typeof file?.arrayBuffer !== "function") throw new Error("missing-array-buffer");
        const data = await file.arrayBuffer();
        if (!(data instanceof ArrayBuffer)) throw new Error("invalid-array-buffer");
        if (data.byteLength > maxFileBytes) {
          errors.push({ name, error: `이미지가 너무 큽니다. (최대 ${Math.floor(maxFileBytes / 1024 / 1024)}MiB)` });
          continue;
        }
        images.push({ name, mime, data });
      } catch {
        errors.push({ name, error: "클립보드 이미지를 읽지 못했습니다." });
      }
    }

    return { images, errors };
  }

  const api = {
    MAX_PASTED_IMAGES,
    MAX_PASTED_IMAGE_BYTES,
    clipboardImageFiles,
    serializeClipboardImages,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.chatClipboard = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
