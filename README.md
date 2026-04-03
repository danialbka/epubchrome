# epubchrome

Minimal Chrome extension that converts the current web page into a local `.epub` file.

## What it does

- extracts the main article-like content from the active tab
- removes common navigation, ads, forms, and boilerplate
- packages the cleaned content into a basic EPUB 3 file
- downloads the result with Chrome's built-in downloads API

## Extraction approach

- the extension now uses the browser build of `defuddle` for article extraction
- EPUB section splitting still happens locally in this project after extraction
- this is closer to how Obsidian Web Clipper gets a cleaner article body than a simple DOM scoring heuristic

## Credits

- this project was informed by the extraction approach used in [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper)
- Obsidian Web Clipper is released under the MIT License
- this extension vendors the browser build of [`defuddle`](https://github.com/kepano/defuddle), the MIT-licensed extraction library used by Obsidian Web Clipper
- no Obsidian Web Clipper source files are copied into this repository; the EPUB-specific logic in this project is original to `epubchrome`

## License note

- please review the upstream MIT-licensed projects if you redistribute or modify this extension:
- Obsidian Web Clipper: https://github.com/obsidianmd/obsidian-clipper/blob/master/LICENSE
- defuddle: https://github.com/kepano/defuddle/blob/main/LICENSE

## Load it in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `G:\epubchrome`

## Use it

1. Open a normal `http` or `https` web page
2. Click the extension icon
3. Click **Convert current page**
4. Save the generated `.epub`

## Notes

- this is a simple MVP, but extraction is now powered by `defuddle`
- image embedding is best-effort and skips unsupported formats like WebP or AVIF
- Chrome internal pages, extension pages, PDFs, and some protected sites cannot be converted
