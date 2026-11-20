// Run as a short-lived Electron app to cache a PNG for the Windows native renderer.
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");

app.whenReady().then(async () => {
  const [source, target] = process.argv.slice(2);
  const image = nativeImage.createFromPath(source);
  let png = image.toPNG();
  if (image.isEmpty()) {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await win.loadURL("about:blank");
    const webp = fs.readFileSync(source).toString("base64");
    const encoded = await win.webContents.executeJavaScript(`(async () => {
      const sprite = new Image();
      sprite.src = 'data:image/webp;base64,${webp}';
      await sprite.decode();
      const canvas = document.createElement('canvas');
      canvas.width = sprite.naturalWidth;
      canvas.height = sprite.naturalHeight;
      canvas.getContext('2d').drawImage(sprite, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`);
    png = Buffer.from(encoded, "base64");
  }
  fs.writeFileSync(target, png, { flag: "wx" });
  app.exit(0);
}).catch((error) => {
  console.error(error.message);
  app.exit(1);
});
