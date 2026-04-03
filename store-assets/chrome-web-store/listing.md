# Chrome Web Store Listing

## Name
epubchrome

## Short Description
Convert web pages into clean EPUB files and optionally upload them straight to your EPUBly library.

## Category
Productivity

## Detailed Description
epubchrome turns the current web page into a readable EPUB you can keep, sideload, or send directly into EPUBly.

It focuses on article-style pages and builds a proper ebook package with cleaner extracted content, cover image support, section splitting for longer pages, and an EPUB table of contents.

Use it when you want to:

- save a long article for offline reading
- turn a web page into an ebook-friendly format
- send a converted page directly into your EPUBly library

Key features:

- one-click conversion from the current tab
- cleaner main-content extraction for article pages
- cover image detection when available
- section-based EPUB output for long pages
- local download as EPUB
- optional upload to EPUBly after connecting your account
- revocable connection token for EPUBly uploads

## Single Purpose Description
Convert the current web page into an EPUB file for local download or upload to the user's connected EPUBly library.

## Support URL
https://www.epubly.net

## Homepage URL
https://www.epubly.net

## Privacy Policy URL
https://www.epubly.net/privacy

## Permission Notes

### `activeTab`
Used to read the page the user explicitly chooses to convert.

### `downloads`
Used to save the generated EPUB file to the user's device.

### `scripting`
Used to inject the extraction script into the current page when needed.

### `storage`
Used to store local extension settings, connection state, and the revocable EPUBly upload token.

### `tabs`
Used to identify the active tab title and to complete the EPUBly pairing flow.

### `<all_urls>`
Required so the extension can convert article pages on the sites the user chooses.

## Privacy Practices Summary

- Page content is read locally in the browser when the user triggers conversion.
- If the user chooses local download only, the EPUB stays on the user's device.
- If the user chooses Upload to EPUBly, the generated EPUB file and related source metadata are uploaded to the user's EPUBly account.
- EPUBly upload access uses a revocable user-specific token.
