import { zipSync } from 'fflate';
import { strBytes } from './document-fixtures';

/** A synthetic 1x1 PNG; clean fixture data only. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

type PptxFixtureSlide = {
  readonly title?: string;
  readonly bullets?: readonly string[];
  readonly numbered?: readonly string[];
  readonly textBox?: string;
  readonly table?: readonly (readonly string[])[];
  readonly image?: boolean;
  readonly notes?: string;
};

type PptxFixtureOptions = {
  readonly title?: string;
  readonly author?: string;
  readonly slides?: readonly PptxFixtureSlide[];
  /** Lists slides in presentation.xml in this order of slide-file indexes. */
  readonly order?: readonly number[];
  readonly includeMacro?: boolean;
  readonly macroContentType?: boolean;
  readonly includeVideo?: boolean;
  readonly includeOleObject?: boolean;
  readonly includeActiveXControl?: boolean;
  readonly includeExternalImage?: boolean;
  readonly includeDoctype?: boolean;
  readonly missingSlide?: boolean;
  readonly wordprocessingMainType?: boolean;
};

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function textShape(id: number, placeholder: string, paragraphs: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="Shape ${String(id)}"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;
}

function paragraph(text: string, properties = ''): string {
  return `<a:p>${properties}<a:r><a:rPr lang="en-US"/><a:t>${xml(text)}</a:t></a:r></a:p>`;
}

function slideXml(slide: PptxFixtureSlide, index: number): string {
  const shapes: string[] = [];
  // The body comes before the title in shape-tree order; the parser must still read the title first.
  if (slide.bullets) {
    shapes.push(textShape(3, '<p:ph idx="1"/>', slide.bullets.map((item, level) =>
      paragraph(item, level === 2 ? '<a:pPr lvl="1"/>' : '')).join('')));
  }
  if (slide.title) shapes.push(textShape(2, '<p:ph type="title"/>', paragraph(slide.title)));
  if (slide.numbered) {
    shapes.push(textShape(4, '', slide.numbered.map((item) =>
      paragraph(item, '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>')).join('')));
  }
  if (slide.textBox) {
    shapes.push(`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${textShape(5, '',
      `<a:p><a:r><a:rPr b="1"/><a:t>Bold</a:t></a:r><a:r><a:rPr/><a:t> and </a:t></a:r><a:r><a:rPr i="1"/><a:t>${xml(slide.textBox)}</a:t></a:r></a:p>`)}</p:grpSp>`);
  }
  if (slide.table) {
    const rows = slide.table.map((row) =>
      `<a:tr h="370840">${row.map((cell) => `<a:tc><a:txBody><a:bodyPr/>${paragraph(cell)}</a:txBody></a:tc>`).join('')}</a:tr>`).join('');
    shapes.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`);
  }
  if (slide.image) {
    shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="7" name="Picture" descr="Synthetic chart ${String(index + 1)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill><p:spPr/></p:pic>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;
}

const DEFAULT_PPTX_SLIDES: readonly PptxFixtureSlide[] = [
  { title: 'Quarterly Research Review', bullets: ['Signals from the field', 'Retention improved', 'Nested evidence point'], image: true },
  { title: 'Findings Table', table: [['Metric', 'Value'], ['Readers', '42'], ['Citations', '7']] },
  { title: 'Next Steps', numbered: ['Draft the synthesis', 'Share with reviewers'], textBox: 'distinctive closing remark', notes: 'Speaker-only note' },
];

export function makePptxFixture(options: PptxFixtureOptions = {}): Buffer {
  const slides = options.slides ?? DEFAULT_PPTX_SLIDES;
  const order = options.order ?? slides.map((_, index) => index);
  const mainType = options.wordprocessingMainType
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    : options.macroContentType
      ? 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml'
      : 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strBytes(`<?xml version="1.0" encoding="UTF-8"?>${options.includeDoctype ? '<!DOCTYPE Types [<!ENTITY x "y">]>' : ''}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${options.includeVideo ? '<Default Extension="mp4" ContentType="video/mp4"/>' : ''}<Override PartName="/ppt/presentation.xml" ContentType="${mainType}"/>${slides.map((_, index) => `<Override PartName="/ppt/slides/slide${String(index + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strBytes(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'docProps/core.xml': strBytes(`<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(options.title ?? 'Fixture Deck')}</dc:title><dc:creator>${xml(options.author ?? 'Fixture Presenter')}</dc:creator></cp:coreProperties>`),
    'ppt/presentation.xml': strBytes(`<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS}><p:sldIdLst>${order.map((slideIndex, position) => `<p:sldId id="${String(256 + position)}" r:id="rIdSlide${String(options.missingSlide && position === 0 ? 99 : slideIndex + 1)}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strBytes(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, index) => `<Relationship Id="rIdSlide${String(index + 1)}" Type="${REL}/slide" Target="slides/slide${String(index + 1)}.xml"/>`).join('')}</Relationships>`),
    'ppt/media/image1.png': new Uint8Array(Buffer.from(PIXEL_PNG, 'base64')),
  };
  slides.forEach((slide, index) => {
    const name = `slide${String(index + 1)}.xml`;
    files[`ppt/slides/${name}`] = strBytes(slideXml(slide, index));
    const relationships = [
      `<Relationship Id="rIdImage" Type="${REL}/image" Target="${options.includeExternalImage ? 'https://attacker.invalid/pixel.png" TargetMode="External' : '../media/image1.png'}"/>`,
      options.includeOleObject && index === 0 ? `<Relationship Id="rIdOle" Type="${REL}/oleObject" Target="../embeddings/oleObject1.bin"/>` : '',
      options.includeActiveXControl && index === 0 ? `<Relationship Id="rIdCtl" Type="${REL}/control" Target="../activeX/activeX1.xml"/>` : '',
      options.includeVideo && index === 0 ? `<Relationship Id="rIdVideo" Type="${REL}/video" Target="../media/clip.mp4"/>` : '',
      slide.notes ? `<Relationship Id="rIdNotes" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${String(index + 1)}.xml"/>` : '',
    ].join('');
    files[`ppt/slides/_rels/${name}.rels`] = strBytes(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`);
    if (slide.notes) {
      files[`ppt/notesSlides/notesSlide${String(index + 1)}.xml`] = strBytes(`<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${textShape(2, '<p:ph type="body"/>', paragraph(slide.notes))}</p:spTree></p:cSld></p:notes>`);
    }
  });
  if (options.includeMacro) files['ppt/vbaProject.bin'] = strBytes('synthetic macro payload');
  if (options.includeVideo) files['ppt/media/clip.mp4'] = strBytes('synthetic video');
  if (options.includeOleObject) files['ppt/embeddings/oleObject1.bin'] = strBytes('synthetic object');
  return Buffer.from(zipSync(files));
}
