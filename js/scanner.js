// ============================================================
// scanner.js — render QR/barcode images, camera scan modal
// ============================================================

const Codes = {
  async renderQR(canvas, value) {
    await QRCode.toCanvas(canvas, value, { width: 84, margin: 0, color: { dark: '#201F2E', light: '#FFFFFF' } });
  },
  renderBarcode(svgEl, value) {
    JsBarcode(svgEl, value, { format: 'CODE128', height: 34, width: 1.4, fontSize: 10, margin: 0, displayValue: true });
  },
};

let html5QrCode = null;

const Scanner = {
  onResult: null,

  open(onResult) {
    this.onResult = onResult;
    document.getElementById('modal-scanner').classList.add('open');
    document.getElementById('scanner-status').textContent = 'Point the camera at the member\'s QR code or barcode.';
    html5QrCode = new Html5Qrcode('scanner-video');
    const config = { fps: 10, qrbox: 220 };
    html5QrCode.start({ facingMode: 'environment' }, config,
      (decodedText) => this.handle(decodedText),
      () => {} // ignore per-frame scan failures
    ).catch((err) => {
      document.getElementById('scanner-status').textContent =
        'Could not access the camera (' + err + '). You can also search manually.';
    });
  },

  handle(decodedText) {
    this.close();
    if (this.onResult) this.onResult(decodedText.trim());
  },

  close() {
    document.getElementById('modal-scanner').classList.remove('open');
    if (html5QrCode) {
      html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
      html5QrCode = null;
    }
  },
};

window.Codes = Codes;
window.Scanner = Scanner;
