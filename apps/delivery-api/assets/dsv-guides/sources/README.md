# DSV guide sources

The PDF files in the parent directory are runtime assets served by the Delivery API. Keep the editable source next to each guide and regenerate the PDF from that source; do not patch compiled PDFs directly.

## Operator guide

The original temporary authoring directory was no longer present. `operator/generate-guide.cjs` was recovered from the 2026-08-11 generation record, and its 49 unique screen assets were recovered from the released PDF. The two obsolete driver QR/invitation screens were replaced with editable, link-only installation illustrations.

Generate the DOCX with the bundled document runtime:

```sh
NODE_PATH="$CODEX_DOCUMENT_NODE_MODULES" \
PRETENDARD_FONT_PATH="/absolute/path/Pretendard-Regular.ttf" \
node operator/generate-guide.cjs
```

Render both DOCX files with `FONTCONFIG_FILE` set to `fontconfig-pretendard.conf`. The Codex renderer uses an isolated home directory, so this explicit font configuration is required for Korean glyphs. Adjust the `<dir>` entry when the workstation font directory differs. Copy the verified PDFs to the parent directory. The current output names are:

- `operator/CLEVER_DSV_관제_운영자_사용자_가이드_Rev1.2.docx`
- `../CLEVER_DSV_관제_운영자_사용자_가이드_Rev1.2.pdf`

## Driver guide

`driver/CLEVER_Driver_설치_현장교육_가이드_Rev1.5.docx` is the editable source. Keep the public entry point at `https://dsv.cleversystem.ai/driver-app`; Android installation and updates use the fixed Google Drive file `clever-driver-latest.apk` linked from that page. Do not publish a second file ID, a QR code, or a one-time driver invitation link. Only advise the Android “install unknown apps” permission for the browser used to download the APK from the official DSV page.
