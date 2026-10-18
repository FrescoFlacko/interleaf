import { zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Realm-stable UTF-8 encoder for zip fixtures.
 *
 * fflate validates entry values with `instanceof` against the `Uint8Array`
 * constructor captured when it is evaluated. Under the jsdom vitest
 * environment that is jsdom-realm while Buffer/TextEncoder emit Node-realm
 * arrays, so both FAIL the check and every entry is flattened as a directory.
 * Copying into an array built by this environment's own `Uint8Array` always
 * matches whatever realm fflate captured. The buffer is reported precisely as
 * `ArrayBuffer` so results stay assignable into fflate's `Unzipped` records.
 */
export function strBytes(value: string): Uint8Array<ArrayBuffer> {
  const encoded = Buffer.from(value, 'utf-8');
  const out = new Uint8Array(encoded.byteLength);
  out.set(encoded);
  return out;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

type EpubFixtureOptions = {
  readonly title?: string;
  readonly author?: string;
  readonly chapters?: readonly { readonly title: string; readonly content: string }[];
  readonly customCss?: string;
  readonly isDrmEncrypted?: boolean;
  readonly maliciousScript?: string;
  readonly maliciousImgSrc?: string;
  readonly maliciousEventHandler?: string;
  readonly includePathTraversalEntry?: boolean;
  readonly encryptionXml?: string;
  readonly includeFontResource?: boolean;
};

export function makeEpubFixture(
  titleOrOptions: string | EpubFixtureOptions = 'Fixture EPUB',
  author = 'Fixture Author'
): Buffer {
  const options: EpubFixtureOptions =
    typeof titleOrOptions === 'string'
      ? { title: titleOrOptions, author }
      : titleOrOptions;

  const docTitle = options.title ?? 'Fixture EPUB';
  const docAuthor = options.author ?? 'Fixture Author';
  const defaultChapters = [
    {
      title: 'Chapter 1: The Beginning',
      content: '<p>Welcome to Interleaf ebook reader. This is the first chapter of the book.</p>',
    },
    {
      title: 'Chapter 2: Architecture & Security',
      content: '<p>EPUB documents are rendered inside sandboxed iframes without script execution.</p>',
    },
    {
      title: 'Chapter 3: Annotations & Deep Work',
      content: '<p>Highlights, notes, and bookmarks allow rich active reading workflows.</p>',
    },
  ];

  const chapters = options.chapters ?? defaultChapters;
  const customCss = options.customCss ?? 'body { font-family: sans-serif; line-height: 1.6; margin: 1.5rem; }';

  const zipFiles: Record<string, Uint8Array> = {
    mimetype: strBytes('application/epub+zip'),
    'META-INF/container.xml': strBytes('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/styles.css': strBytes(customCss),
  };

  // DRM encryption.xml if requested
  if (options.encryptionXml) {
    zipFiles['META-INF/encryption.xml'] = strBytes(options.encryptionXml);
  } else if (options.isDrmEncrypted) {
    zipFiles['META-INF/encryption.xml'] = strBytes(`<?xml version="1.0"?>
    <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
      <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://ns.adobe.com/adept"/>
    <enc:CipherData>
      <enc:CipherReference URI="OEBPS/chapter1.xhtml"/>
    </enc:CipherData>
      </enc:EncryptedData>
    </encryption>`);
  }

  // Path traversal entry if requested
  if (options.includePathTraversalEntry) {
    zipFiles['../escaped-file.txt'] = strBytes('Malicious path traversal payload');
  }

  // Manifest items and spine items
  const manifestItems: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="styles.css" media-type="text/css"/>',
  ];
  if (options.includeFontResource) {
    zipFiles['OEBPS/fonts/reader.ttf'] = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0]);
    manifestItems.push('<item id="reader-font" href="fonts/reader.ttf" media-type="font/ttf"/>');
  }
  const spineItems: string[] = [];
  const navPoints: string[] = [];
  const navLis: string[] = [];

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]!;
    const id = `chapter${String(i + 1)}`;
    const filename = `OEBPS/${id}.xhtml`;

    manifestItems.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${id}"/>`);
    navPoints.push(`
    <navPoint id="np-${String(i + 1)}" playOrder="${String(i + 1)}">
      <navLabel><text>${xml(ch.title)}</text></navLabel>
      <content src="${id}.xhtml"/>
    </navPoint>`);
    navLis.push(`<li><a href="${id}.xhtml">${xml(ch.title)}</a></li>`);

    let contentHtml = ch.content;
    if (i === 0 && options.maliciousScript) {
      contentHtml += `\n<script>${options.maliciousScript}</script>`;
    }
    if (i === 0 && options.maliciousEventHandler) {
      contentHtml += `\n<div ${options.maliciousEventHandler}>Adversarial Event Handler</div>`;
    }
    if (i === 0 && options.maliciousImgSrc) {
      contentHtml += `\n<img src="${options.maliciousImgSrc}" alt="Tracker" />`;
    }

    const chapterHtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${xml(ch.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <h1>${xml(ch.title)}</h1>
  ${contentHtml}
</body>
</html>`;

    zipFiles[filename] = strBytes(chapterHtml);
  }

  // OPF Package Document
  const opfXml = `<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" unique-identifier="pub-id" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:12345678-1234-5678-1234-567812345678</dc:identifier>
    <dc:title>${xml(docTitle)}</dc:title>
    <dc:creator>${xml(docAuthor)}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('\n    ')}
  </spine>
</package>`;
  zipFiles['OEBPS/content.opf'] = strBytes(opfXml);

  // EPUB 3 Nav Document
  const navXml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
      ${navLis.join('\n      ')}
    </ol>
  </nav>
</body>
</html>`;
  zipFiles['OEBPS/nav.xhtml'] = strBytes(navXml);

  // EPUB 2 NCX Document
  const ncxXml = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:12345678-1234-5678-1234-567812345678"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${xml(docTitle)}</text></docTitle>
  <navMap>
    ${navPoints.join('\n')}
  </navMap>
</ncx>`;
  zipFiles['OEBPS/toc.ncx'] = strBytes(ncxXml);
  // OCF requires the `mimetype` entry first AND stored (no compression);
  // level 0 keeps every entry stored so signature validation passes.
  return Buffer.from(zipSync(zipFiles, { level: 0 }));
}

type MobiFixtureOptions = {
  readonly title?: string;
  readonly author?: string;
  readonly chapters?: readonly { readonly title: string; readonly content: string }[];
  readonly isDrmEncrypted?: boolean;
  readonly maliciousScript?: string;
  readonly maliciousEventHandler?: string;
  readonly maliciousImgSrc?: string;
  readonly rasterResource?: Uint8Array;
};

export function makeMobiFixture(options?: MobiFixtureOptions): Buffer {
  const docTitle = options?.title ?? 'Fixture MOBI Book';
  const defaultChapters = [
    {
      title: 'Chapter 1: The Palm Journey',
      content: '<p>Welcome to MOBI reading in Interleaf. Standard PalmDOC records are parsed and sanitized.</p>',
    },
    {
      title: 'Chapter 2: Security Boundaries',
      content: '<p>All HTML content is stripped of scripts and rendered in isolated frames.</p>',
    },
    {
      title: 'Chapter 3: Highlights and Notes',
      content: '<p>Annotations anchor to section positions seamlessly.</p>',
    },
  ];

  const chapters = options?.chapters ?? defaultChapters;
  let fullHtml = `<html><head><title>${docTitle}</title></head><body>`;
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]!;
    if (i > 0) fullHtml += '<mbp:pagebreak/>';
    fullHtml += `<h1>${ch.title}</h1>\n${ch.content}\n`;
    if (i === 0 && options?.maliciousScript) {
      fullHtml += `<script>${options.maliciousScript}</script>\n`;
    }
    if (i === 0 && options?.maliciousEventHandler) {
      fullHtml += `<div ${options.maliciousEventHandler}>Adversarial MOBI Event Handler</div>\n`;
    }
    if (i === 0 && options?.maliciousImgSrc) {
      fullHtml += `<img src="${options.maliciousImgSrc}" alt="Tracker" />\n`;
    }
    if (i === 0 && options?.rasterResource) {
      fullHtml += '<img recindex="1" alt="Embedded MOBI raster" />\n';
    }
  }
  fullHtml += '</body></html>';

  const textBytes = Buffer.from(fullHtml, 'utf-8');
  const recordSize = 4096;
  const numTextRecords = Math.max(1, Math.ceil(textBytes.length / recordSize));
  const textRecords: Buffer[] = [];

  for (let i = 0; i < numTextRecords; i++) {
    const chunk = textBytes.subarray(i * recordSize, (i + 1) * recordSize);
    textRecords.push(chunk);
  }

  // Total records = Record 0 (Headers) + Text Records
  const resourceRecords = options?.rasterResource
    ? [Buffer.from(options.rasterResource)]
    : [];
  const numRecords = 1 + numTextRecords + resourceRecords.length;

  // Build Record 0
  const titleBytes = Buffer.from(docTitle, 'utf-8');
  const rec0HeaderLen = 16 + 232; // PalmDOC header (16) + MOBI header (232)
  const titleOffset = rec0HeaderLen;
  const rec0 = Buffer.alloc(rec0HeaderLen + titleBytes.length + 32);

  // 1. PalmDOC Header (16 bytes)
  rec0.writeUInt16BE(1, 0); // Compression: 1 (none/uncompressed for deterministic tests)
  rec0.writeUInt16BE(0, 2); // Unused
  rec0.writeUInt32BE(textBytes.length, 4); // Text length
  rec0.writeUInt16BE(numTextRecords, 8); // Number of text records
  rec0.writeUInt16BE(recordSize, 10); // Record size
  rec0.writeUInt16BE(options?.isDrmEncrypted ? 2 : 0, 12); // Encryption type (2 = DRM, 0 = none)
  rec0.writeUInt16BE(0, 14); // Unknown

  // 2. MOBI Header (starts at offset 16)
  rec0.write('MOBI', 16, 4, 'ascii'); // Magic
  rec0.writeUInt32BE(232, 20); // Header length
  rec0.writeUInt32BE(2, 24); // Mobi type (2 = Book)
  rec0.writeUInt32BE(65001, 28); // Text encoding (65001 = UTF-8)
  rec0.writeUInt32BE(123456789, 32); // Unique ID
  rec0.writeUInt32BE(6, 36); // File version
  rec0.writeUInt32BE(titleOffset, 84); // Title offset (relative to rec0 start)
  rec0.writeUInt32BE(titleBytes.length, 88); // Title length
  rec0.writeUInt8(0, 94); // Locale region
  rec0.writeUInt8(9, 95); // Locale language (English)
  rec0.writeUInt32BE(numTextRecords + 1, 108); // Resource start record index

  // Write Title
  titleBytes.copy(rec0, titleOffset);

  // Build PDB File
  const pdbHeaderLen = 78;
  const recordListLen = numRecords * 8 + 2; // 8 bytes per record + 2 byte gap
  let currentOffset = pdbHeaderLen + recordListLen;

  const recordOffsets: number[] = [currentOffset];
  currentOffset += rec0.length;

  for (const tr of textRecords) {
    recordOffsets.push(currentOffset);
    currentOffset += tr.length;
  }
  for (const resource of resourceRecords) {
    recordOffsets.push(currentOffset);
    currentOffset += resource.length;
  }

  const fileBuffer = Buffer.alloc(currentOffset);

  // 1. PDB Header
  const pdbName = Buffer.from(docTitle.slice(0, 31), 'ascii');
  pdbName.copy(fileBuffer, 0);
  fileBuffer.write('BOOK', 60, 4, 'ascii');
  fileBuffer.write('MOBI', 64, 4, 'ascii');
  fileBuffer.writeUInt16BE(numRecords, 76);

  // 2. Record List
  for (let i = 0; i < numRecords; i++) {
    const listOffset = pdbHeaderLen + i * 8;
    fileBuffer.writeUInt32BE(recordOffsets[i]!, listOffset);
    fileBuffer.writeUInt8(0, listOffset + 4); // Attributes
    fileBuffer.writeUInt8(0, listOffset + 5);
    fileBuffer.writeUInt16BE(i, listOffset + 6); // Unique ID
  }

  // 3. Write Record 0
  rec0.copy(fileBuffer, recordOffsets[0]);

  // 4. Write Text Records
  for (let i = 0; i < numTextRecords; i++) {
    textRecords[i]!.copy(fileBuffer, recordOffsets[i + 1]);
  }
  for (let i = 0; i < resourceRecords.length; i++) {
    resourceRecords[i]!.copy(fileBuffer, recordOffsets[1 + numTextRecords + i]);
  }

  return fileBuffer;
}

/**
 * Calibre 8.13-generated KF8/AZW3 fixture built from original Interleaf test
 * text. Stored as base64 so the fixture remains reviewable and patchable.
 */
export function makeKf8Fixture(): Buffer {
  const encoded = readFileSync(join(process.cwd(), 'tests/fixtures/sample.azw3.base64'), 'utf8');
  return Buffer.from(encoded.replaceAll(/\s/g, ''), 'base64');
}

type DocxFixtureOptions = {
  readonly title?: string;
  readonly author?: string;
  readonly bodyText?: string;
  readonly includeImage?: boolean;
  readonly invalidImageSignature?: boolean;
  readonly includeExternalRelationship?: boolean;
  readonly includeExternalImageRelationship?: boolean;
  readonly includeMacro?: boolean;
  readonly encodedMacroContentType?: boolean;
  readonly includeActiveX?: boolean;
  readonly includeArbitraryActiveRelationship?: boolean;
  readonly includeExtensibilityRelationship?: boolean;
  readonly includeEmbeddedObject?: boolean;
  readonly includePathTraversalEntry?: boolean;
  readonly malformedDocumentXml?: boolean;
  readonly oversizedImageDimensions?: boolean;
  readonly tableRows?: number;
  readonly extraParagraphs?: number;
};

function fixtureBytes(encoded: string): Uint8Array {
  const source = Buffer.from(encoded, 'base64');
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return bytes;
}

export function makeDocxFixture(
  titleOrOptions: string | DocxFixtureOptions = 'Fixture DOCX',
  author = 'Fixture Author'
): Buffer {
  const options: DocxFixtureOptions = typeof titleOrOptions === 'string'
    ? { title: titleOrOptions, author }
    : titleOrOptions;
  const title = options.title ?? 'Fixture DOCX';
  const creator = options.author ?? 'Fixture Author';
  const bodyText = options.bodyText ?? 'Stable semantic anchors make DOCX research notes durable.';
  const tableRows = Array.from({ length: options.tableRows ?? 1 }, (_, index) =>
    `<w:tr><w:tc><w:p><w:r><w:t>Term ${String(index + 1)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Definition ${String(index + 1)}</w:t></w:r></w:p></w:tc></w:tr>`
  ).join('');
  const extraParagraphs = Array.from({ length: options.extraParagraphs ?? 0 }, (_, index) =>
    `<w:p><w:r><w:t>Cancellation stress paragraph ${String(index + 1)}</w:t></w:r></w:p>`
  ).join('');
  const documentXml = options.malformedDocumentXml
    ? '<?xml version="1.0"?><w:document><w:body><w:p>'
    : `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <w:body>
          <w:sdt><w:sdtContent><w:p><w:pPr><w:pStyle w:val="CustomHeading"/><w:jc w:val="center"/></w:pPr><w:r><w:t>DOCX Foundations</w:t></w:r></w:p></w:sdtContent></w:sdt>
          <w:p><w:r><w:t>${xml(bodyText)}</w:t></w:r></w:p>
          <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold insight</w:t></w:r><w:r><w:t> and </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>italic context</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Semantic list item</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Ordered item three</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Nested bullet</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Ordered item four</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>Restarted item ten</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="4"/></w:numPr></w:pPr><w:r><w:t>Alphabetic item</w:t></w:r></w:p>
          <w:tbl>${tableRows}</w:tbl>
          ${options.includeImage === false ? '' : '<w:p><w:r><w:drawing><a:blip r:embed="rIdImage1"/></w:drawing></w:r></w:p>'}
          ${options.includeExternalImageRelationship ? '<w:p><w:r><w:drawing><a:blip r:embed="rIdExternalImage"/></w:drawing></w:r></w:p>' : ''}
          ${extraParagraphs}
          <w:p><w:r><w:br w:type="page"/><w:t>Explicit page boundary</w:t></w:r></w:p>
          <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Second Section</w:t></w:r></w:p>
          <w:p><w:r><w:t>Searchable phrase after the page break.</w:t></w:r></w:p>
        </w:body>
      </w:document>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      ${options.includeImage === false ? '' : '<Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'}
      ${options.includeExternalRelationship ? '<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.invalid/track" TargetMode="External"/>' : ''}
      ${options.includeExternalImageRelationship ? '<Relationship Id="rIdExternalImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://attacker.invalid/pixel.png" TargetMode="External"/>' : ''}
      ${options.includeArbitraryActiveRelationship ? '<Relationship Id="rIdObject" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="custom/innocent.dat"/>' : ''}
      ${options.includeExtensibilityRelationship ? '<Relationship Id="rIdCustomUi" Type="http://schemas.microsoft.com/office/2006/relationships/ui/extensibility" Target="customUI/innocent.xml"/>' : ''}
    </Relationships>`;
  const documentContentType = options.encodedMacroContentType
    ? 'application/vnd.ms-word.document.macro&#69;nabled.main+xml'
    : `application/vnd.openxmlformats-officedocument.wordprocessingml.${options.includeMacro ? 'macroEnabled' : 'document'}.main+xml`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/>
      <Override PartName="/word/document.xml" ContentType="${documentContentType}"/>
      <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
    </Types>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strBytes(contentTypes),
    '_rels/.rels': strBytes('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strBytes(documentXml),
    'word/styles.xml': strBytes('<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="CustomHeading"><w:name w:val="custom title"/><w:basedOn w:val="Heading1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>'),
    'word/numbering.xml': strBytes('<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="lowerRoman"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="10"/></w:lvlOverride></w:num><w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num></w:numbering>'),
    'word/_rels/document.xml.rels': strBytes(relationships),
    'docProps/core.xml': strBytes(`<?xml version="1.0"?><cp:coreProperties xmlns:cp="urn:core" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:creator>${xml(creator)}</dc:creator></cp:coreProperties>`),
  };
  if (options.includeImage !== false) {
    if (options.invalidImageSignature) {
      files['word/media/image1.png'] = strBytes('<svg onload="alert(1)"></svg>');
    } else {
      const image = fixtureBytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
      if (options.oversizedImageDimensions) {
        image[16] = 0x00;
        image[17] = 0x01;
        image[18] = 0x00;
        image[19] = 0x00;
      }
      files['word/media/image1.png'] = image;
    }
  }
  if (options.includeMacro) files['word/vbaProject.bin'] = strBytes('hostile macro');
  if (options.includeActiveX) files['word/activeX/activeX1.bin'] = strBytes('hostile ActiveX');
  if (options.includeArbitraryActiveRelationship) files['word/custom/innocent.dat'] = strBytes('embedded object');
  if (options.includeExtensibilityRelationship) files['word/customUI/innocent.xml'] = strBytes('<customUi/>');
  if (options.includeEmbeddedObject) files['word/embeddings/object1.bin'] = strBytes('embedded object');
  if (options.includePathTraversalEntry) files['../escape.txt'] = strBytes('escape');
  return Buffer.from(zipSync(files));
}

export function makePdfFixture(options?: {
  readonly title?: string;
  readonly author?: string;
  readonly pages?: readonly string[];
  readonly pageLines?: readonly (readonly string[])[];
  readonly pageStartPositions?: readonly (readonly [number, number])[];
  readonly outline?: readonly { readonly title: string; readonly targetPage: number }[];
  readonly mediaBox?: readonly [number, number, number, number];
  /** Per-page `/Rotate` value (0/90/180/270). Missing entries default to 0. */
  readonly pageRotations?: readonly number[];
  /**
   * 1-based page numbers whose text is drawn with an encoding that maps
   * ASCII A.. onto Hebrew alef.. (`/afii576xx` glyph names). PDF.js resolves
   * those names through the standard glyph list, so `getTextContent()` yields
   * RTL codepoints and the text layer marks the spans `dir="rtl"`.
   */
  readonly rtlPages?: readonly number[];
  /**
   * 1-based page numbers whose text is drawn with a font whose `/ToUnicode`
   * CMap maps ASCII `A` onto U+FB00 (the `ﬀ` ligature). PDF.js normalizes that
   * codepoint to `"ff"` unless `disableNormalization` is set, so a fixture page
   * containing `A` yields a one-character run un-normalized and a
   * two-character run normalized — the smallest signal that distinguishes the
   * two text-extraction spaces.
   */
  readonly ligaturePages?: readonly number[];
  /**
   * 1-based page numbers whose lines are each wrapped in a
   * `/P <</MCID n>> BDC … EMC` block. `getTextContent()` then emits
   * `beginMarkedContentProps`/`endMarkedContent` entries around every text
   * item, and PDF.js's `TextLayer` nests each glyph span inside its own
   * `<span class="markedContent">` container — the real structure a tagged PDF
   * produces, and the one search-anchor resolution has to traverse.
   */
  readonly markedContentPages?: readonly number[];
  readonly embeddedJavaScript?: string;
  readonly links?: readonly {
    readonly pageNumber: number;
    readonly rect: readonly [number, number, number, number];
    readonly targetPage?: number;
    readonly destCoords?: readonly [number, number];
    readonly destMode?: 'XYZ' | 'Fit' | 'FitH' | 'FitV';
    readonly url?: string;
  }[];
}): Buffer {
  const pages = options?.pages ?? options?.pageLines?.map((lines) => lines.join(' ')) ?? [
    'Chapter 1: Foundations of Distributed Systems. Data-intensive applications require robust architectures.',
    'Chapter 2: Data Models and Query Languages. Relational models vs document models vs graph models.',
    'Chapter 3: Storage and Retrieval. Log-structured storage, LSM-trees, and B-trees.',
  ];

  const outlineItems = options?.outline ?? [
    { title: 'Chapter 1: Foundations', targetPage: 1 },
    { title: 'Chapter 2: Data Models', targetPage: 2 },
    { title: 'Chapter 3: Storage', targetPage: 3 },
  ];
  const docTitle = options?.title ?? 'Distributed Systems Guide';
  const docAuthor = options?.author ?? 'Martin Kleppmann';
  const mediaBox = options?.mediaBox ?? [0, 0, 612, 792];
  const escapedJavaScript = options?.embeddedJavaScript
    ?.replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
  const openAction = escapedJavaScript
    ? ` /OpenAction << /S /JavaScript /JS (${escapedJavaScript}) >>`
    : '';
  const inlineAnnotation = escapedJavaScript
    ? ` /Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] /A << /S /JavaScript /JS (${escapedJavaScript}) >> >>]`
    : '';

  const objects: string[] = [];
  const numPages = pages.length;
  const pageObjIds: number[] = [];
  for (let i = 0; i < numPages; i++) {
    pageObjIds.push(6 + i * 2);
  }

  const outlineObjIds: number[] = [];
  for (let i = 0; i < outlineItems.length; i++) {
    outlineObjIds.push(6 + numPages * 2 + i);
  }

  // Appended last so existing object numbering is untouched.
  const rtlFontObjId = 6 + numPages * 2 + outlineItems.length;
  const rtlPages = new Set(options?.rtlPages ?? []);
  const ligatureFontObjId = rtlFontObjId + 1;
  const ligatureToUnicodeObjId = rtlFontObjId + 2;
  const ligaturePages = new Set(options?.ligaturePages ?? []);
  const markedContentPages = new Set(options?.markedContentPages ?? []);

  // 1: Catalog
  objects.push(
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R${openAction} >>\nendobj`
  );

  // 2: Pages tree
  const kidsStr = pageObjIds.map((id) => `${String(id)} 0 R`).join(' ');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kidsStr}] /Count ${String(numPages)} >>\nendobj`);

  // 3: Outlines root
  if (outlineItems.length > 0) {
    const firstId = outlineObjIds[0]!;
    const lastId = outlineObjIds[outlineObjIds.length - 1]!;
    objects.push(
      `3 0 obj\n<< /Type /Outlines /First ${String(firstId)} 0 R /Last ${String(
        lastId
      )} 0 R /Count ${String(outlineItems.length)} >>\nendobj`
    );
  } else {
    objects.push(`3 0 obj\n<< /Type /Outlines /Count 0 >>\nendobj`);
  }

  // 4: Document Info dictionary
  const escapedTitle = docTitle.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const escapedAuthor = docAuthor.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  objects.push(`4 0 obj\n<< /Title (${escapedTitle}) /Author (${escapedAuthor}) >>\nendobj`);

  // 5: Base Font
  objects.push(`5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`);

  // Pages & Content streams
  for (let i = 0; i < numPages; i++) {
    const pageObjId = pageObjIds[i]!;
    const contentObjId = pageObjId + 1;
    const pageLines = options?.pageLines?.[i] ?? [pages[i] ?? `Page ${String(i + 1)}`];
    const escapedLines = pageLines.map((line) =>
      line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
    );
    const marked = markedContentPages.has(i + 1);
    const lineCommands = escapedLines
      .map((line, lineIndex) => {
        const advance = lineIndex === 0 ? '' : '0 -18 Td\n';
        const show = `(${line}) Tj`;
        // An inline BDC property dictionary needs no /Properties resource.
        return marked
          ? `${advance}/P <</MCID ${String(lineIndex)}>> BDC\n${show}\nEMC`
          : `${advance}${show}`;
      })
      .join('\n');
    const startPos = options?.pageStartPositions?.[i] ?? [72, 720];
    const fontName = rtlPages.has(i + 1) ? '/F2' : ligaturePages.has(i + 1) ? '/F3' : '/F1';
    const stream = `BT\n${fontName} 14 Tf\n${String(startPos[0])} ${String(startPos[1])} Td\n${lineCommands}\nET`;
    const streamLength = Buffer.byteLength(stream);
    const rotation = options?.pageRotations?.[i] ?? 0;
    const rotateEntry = rotation === 0 ? '' : ` /Rotate ${String(rotation)}`;
    const pageLinks = (options?.links ?? [])
      .map((link, linkIndex) => ({ link, id: ligatureToUnicodeObjId + 1 + linkIndex }))
      .filter(({ link }) => link.pageNumber === i + 1);
    const annotsStr = pageLinks.length > 0
      ? ` /Annots [${pageLinks.map(({ id }) => `${String(id)} 0 R`).join(' ')}]`
      : inlineAnnotation;
    objects.push(
      `${String(
        pageObjId
      )} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(
        ' '
      )}]${rotateEntry} /Contents ${String(
        contentObjId
      )} 0 R /Resources << /Font << /F1 5 0 R /F2 ${String(
        rtlFontObjId
      )} 0 R /F3 ${String(ligatureFontObjId)} 0 R >> >>${annotsStr} >>\nendobj`
    );
    objects.push(
      `${String(contentObjId)} 0 obj\n<< /Length ${String(streamLength)} >>\nstream\n${stream}\nendstream\nendobj`
    );
  }

  // Outline items
  for (let i = 0; i < outlineItems.length; i++) {
    const objId = outlineObjIds[i]!;
    const item = outlineItems[i]!;
    const targetPageIndex = Math.max(0, Math.min(numPages - 1, item.targetPage - 1));
    const targetPageId = pageObjIds[targetPageIndex]!;
    const prev = i > 0 ? `/Prev ${String(outlineObjIds[i - 1])} 0 R` : '';
    const next = i < outlineItems.length - 1 ? `/Next ${String(outlineObjIds[i + 1])} 0 R` : '';
    const itemTitle = item.title.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');

    objects.push(
      `${String(objId)} 0 obj\n<< /Title (${itemTitle}) /Parent 3 0 R /Dest [${String(
        targetPageId
      )} 0 R /Fit] ${prev} ${next} >>\nendobj`
    );
  }

  // RTL font. Always emitted (and always referenced as /F2) so object numbering
  // is identical whether or not a fixture asks for RTL pages.
  const hebrewDifferences = Array.from({ length: 26 }, (_, i) => `/afii${String(57664 + i)}`).join(
    ' '
  );
  objects.push(
    `${String(
      rtlFontObjId
    )} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [65 ${hebrewDifferences}] >> >>\nendobj`
  );

  // Ligature font. Like the RTL font it is always emitted (and always
  // referenced as /F3) so object numbering does not depend on the options.
  // Objects must be pushed in ascending id order: the xref below assigns
  // entries by array position.
  objects.push(
    `${String(
      ligatureFontObjId
    )} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${String(
      ligatureToUnicodeObjId
    )} 0 R >>\nendobj`
  );
  const ligatureCMap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    '1 beginbfchar',
    // 'A' (0x41) maps to U+FB00 LATIN SMALL LIGATURE FF.
    '<41> <FB00>',
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  objects.push(
    `${String(ligatureToUnicodeObjId)} 0 obj\n<< /Length ${String(
      Buffer.byteLength(ligatureCMap)
    )} >>\nstream\n${ligatureCMap}\nendstream\nendobj`
  );

  // Link annotations. Emitted in ascending object ID order.
  const linkItems = options?.links ?? [];
  for (let i = 0; i < linkItems.length; i++) {
    const link = linkItems[i]!;
    const objId = ligatureToUnicodeObjId + 1 + i;
    const rectStr = link.rect.join(' ');
    if (link.url) {
      const escapedUrl = link.url.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
      objects.push(
        `${String(objId)} 0 obj\n<< /Type /Annot /Subtype /Link /Rect [${rectStr}] /A << /S /URI /URI (${escapedUrl}) >> >>\nendobj`
      );
    } else {
      const targetPageIdx = Math.max(0, Math.min(numPages - 1, (link.targetPage ?? 1) - 1));
      const targetPageId = pageObjIds[targetPageIdx]!;
      const mode = link.destMode ?? 'XYZ';
      const coords = link.destCoords ?? [72, 720];
      const destStr =
        mode === 'XYZ'
          ? `${String(targetPageId)} 0 R /XYZ ${String(coords[0])} ${String(coords[1])} null`
          : `${String(targetPageId)} 0 R /${mode}`;
      objects.push(
        `${String(objId)} 0 obj\n<< /Type /Annot /Subtype /Link /Rect [${rectStr}] /Dest [${destStr}] >>\nendobj`
      );
    }
  }

  const xrefEntries = ['0000000000 65535 f '];
  let body = '%PDF-1.4\n';

  for (const obj of objects) {
    const objStr = `${obj}\n`;
    const objOffset = Buffer.byteLength(body);
    const padded = String(objOffset).padStart(10, '0');
    xrefEntries.push(`${padded} 00000 n `);
    body += objStr;
  }

  const xrefOffset = Buffer.byteLength(body);
  const xref = `xref\n0 ${String(objects.length + 1)}\n${xrefEntries.join('\n')}\n`;
  const trailer = `trailer\n<< /Size ${String(
    objects.length + 1
  )} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'utf-8');
}

/**
 * A one-page PDF whose page-one artwork is a single content stream larger than
 * one 256 KiB preview range read. PDF.js loads a stream's chunks as one
 * contiguous range request, the way a real cover image arrives. The red
 * rectangle is drawn only after the padding, so a cover that shows it proves
 * the whole stream was read. The rectangle spans x 100–500, y 200–600 in PDF
 * units on a 612×792 page.
 */
export function makeLargeCoverStreamPdfFixture(streamBytes = 400 * 1024): Buffer {
  const drawing = '1 0 0 rg 100 200 400 400 re f\n';
  const content = `${' '.repeat(Math.max(0, streamBytes - drawing.length - 1))}\n${drawing}`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${String(Buffer.byteLength(content))} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];
  let body = '%PDF-1.4\n';
  const xrefEntries = ['0000000000 65535 f '];
  for (const object of objects) {
    xrefEntries.push(`${String(Buffer.byteLength(body)).padStart(10, '0')} 00000 n `);
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  const xref = `xref\n0 ${String(objects.length + 1)}\n${xrefEntries.join('\n')}\n`;
  const trailer = `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

type MarkdownFixtureOptions = {
  readonly title?: string;
  readonly author?: string;
  readonly body?: string;
  readonly useFrontmatter?: boolean;
  readonly bom?: boolean;
  readonly extension?: '.md' | '.markdown';
};

/**
 * Creates a Markdown fixture buffer with optional frontmatter, BOM, and representative GFM content.
 */
export function makeMarkdownFixture(options?: MarkdownFixtureOptions): Buffer {
  const title = options?.title ?? 'Fixture Markdown';
  const author = options?.author ?? 'Test Author';
  const useFrontmatter = options?.useFrontmatter ?? true;
  const bom = options?.bom ?? false;

  const body = options?.body ?? `# ${title}

## Introduction

This is a **bold** and *italic* paragraph with \`inline code\` and ~~strikethrough~~ text.

### Formatting Examples

> A blockquote with a [safe link](https://example.com "Example") inside.

- Unordered item one
- Unordered item two
  - Nested item

1. Ordered first
2. Ordered second

- [x] Completed task
- [ ] Pending task

\`\`\`javascript
function greet(name) {
  return 'Hello, ' + name;
}
\`\`\`

| Header A | Header B |
| -------- | -------- |
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |

---

Final paragraph with ***bold italic*** text.
`;

  let content = '';
  if (bom) {
    content += '\uFEFF';
  }
  if (useFrontmatter) {
    content += `---\ntitle: "${title}"\nauthor: "${author}"\n---\n\n`;
  }
  content += body;

  return Buffer.from(content, 'utf-8');
}

/**
 * Builds a deterministic, hand-assembled ZIP64 archive whose central directory
 * entry declares a 0xFFFFFFFF compressed size while the extra field omits the
 * 0x0001 ZIP64 record.
 *
 * This is the malformed shape covered by GHSA-px8p-9vwx-vf98: fflate 0.8.2
 * scanned for the missing record without a bound and never terminated. It is
 * assembled here from the ZIP specification rather than copied from any
 * external payload, and every offset is internally consistent so the archive
 * reaches the ZIP64 header parser instead of failing earlier.
 */
export function makeMalformedZip64Archive(): Uint8Array {
  const name = strBytes('a.txt');
  const content = strBytes('hi');
  const localHeaderSize = 30 + name.byteLength + content.byteLength;
  const centralSize = 46 + name.byteLength + 4;
  const centralOffset = localHeaderSize;
  const zip64EndOffset = centralOffset + centralSize;
  const archive = new Uint8Array(zip64EndOffset + 56 + 20 + 22);
  const view = new DataView(archive.buffer);
  const u16 = (offset: number, value: number): void => {
    view.setUint16(offset, value, true);
  };
  const u32 = (offset: number, value: number): void => {
    view.setUint32(offset, value, true);
  };
  const u64 = (offset: number, value: number): void => {
    view.setBigUint64(offset, BigInt(value), true);
  };

  u32(0, 0x04034b50);
  u16(4, 20);
  u32(18, content.byteLength);
  u32(22, content.byteLength);
  u16(26, name.byteLength);
  archive.set(name, 30);
  archive.set(content, 30 + name.byteLength);

  u32(centralOffset, 0x02014b50);
  u16(centralOffset + 4, 20);
  u16(centralOffset + 6, 20);
  u32(centralOffset + 20, 0xffffffff);
  u32(centralOffset + 24, content.byteLength);
  u16(centralOffset + 28, name.byteLength);
  u16(centralOffset + 30, 4);
  archive.set(name, centralOffset + 46);
  u16(centralOffset + 46 + name.byteLength, 0x5455);

  u32(zip64EndOffset, 0x06064b50);
  u64(zip64EndOffset + 4, 44);
  u16(zip64EndOffset + 12, 45);
  u16(zip64EndOffset + 14, 45);
  u64(zip64EndOffset + 24, 1);
  u64(zip64EndOffset + 32, 1);
  u64(zip64EndOffset + 40, centralSize);
  u64(zip64EndOffset + 48, centralOffset);

  const locatorOffset = zip64EndOffset + 56;
  u32(locatorOffset, 0x07064b50);
  u64(locatorOffset + 8, zip64EndOffset);
  u32(locatorOffset + 16, 1);

  const endOffset = locatorOffset + 20;
  u32(endOffset, 0x06054b50);
  u16(endOffset + 8, 1);
  u16(endOffset + 10, 1);
  u32(endOffset + 12, centralSize);
  u32(endOffset + 16, 0xffffffff);

  return archive;
}
