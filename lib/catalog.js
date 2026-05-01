const { getTranslation } = require('./translations');

const NAMESPACES = {
  ATOM: 'http://www.w3.org/2005/Atom',
  DC: 'http://purl.org/dc/terms/',
  OPDS: 'http://opds-spec.org/2010/catalog',
  OPENSEARCH: 'http://a9.com/-/spec/opensearch/1.1/'
};

const CONTENT_TYPES = [
  'book_nonfiction',
  'book_fiction',
  'book_unknown',
  'magazine',
  'book_comic',
  'standards_document',
  'musical_score',
  'other'
];

const SUBCATEGORIES = require('./categories.json');
const CATEGORIES = Object.keys(SUBCATEGORIES);

const escapeXml = (str) => str ? str
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;') : '';

const mime = require('mime-types');

const inferMimeForBook = (book) => {
  if (book && book.mimeType && book.mimeType !== 'application/octet-stream') return book.mimeType;
  // Prefer explicit format tags (client populates tags like 'EPUB', 'PDF')
  const formatTagMap = {
    'EPUB': 'application/epub+zip',
    'PDF': 'application/pdf',
    'MOBI': 'application/x-mobipocket-ebook',
    'AZW3': 'application/vnd.amazon.ebook',
    'AZW': 'application/vnd.amazon.ebook',
    'DOC': 'application/msword',
    'DOCX': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'RTF': 'application/rtf',
    'TXT': 'text/plain',
    'CBZ': 'application/vnd.comicbook+zip',
    'CBR': 'application/vnd.comicbook-rar'
  };
  if (book && Array.isArray(book.tags)) {
    for (const t of book.tags) {
      try {
        const up = String(t).trim().toUpperCase();
        if (formatTagMap[up]) return formatTagMap[up];
        // tags like 'EPUB' may appear with extra text, try extract word
        const m = up.match(/\b(EPUB|PDF|MOBI|AZW3|AZW|DOCX|DOC|RTF|TXT|CBZ|CBR)\b/);
        if (m && m[1] && formatTagMap[m[1]]) return formatTagMap[m[1]];
      } catch (e) {}
    }
  }
  // Try filePath first
  const candidates = [book?.filePath, book?.title, book?.downloadUrl].filter(Boolean);
  for (const c of candidates) {
    try {
      // decode and find extension-like suffix
      const decoded = decodeURIComponent(c);
      const m = decoded.match(/\.([a-z0-9]{2,6})(?:$|[\s?%\)])/i);
      if (m && m[1]) {
        const ext = m[1].toLowerCase();
        const looked = mime.lookup(ext);
        if (looked) return looked;
      }
    } catch (e) {}
  }
  return book?.mimeType || 'application/octet-stream';
};

const feedHeader = (title, id, baseUrl, selfUrl, searchUrl) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="${NAMESPACES.ATOM}" xmlns:dc="${NAMESPACES.DC}" xmlns:opds="${NAMESPACES.OPDS}">
  <id>${id}</id>
  <title>${escapeXml(title)}</title>
  <updated>${new Date().toISOString()}</updated>
  <author><name>OPDS Server - Anna's Library</name></author>
  <link rel="self" href="${escapeXml(selfUrl || baseUrl)}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${baseUrl}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="search" href="${escapeXml(searchUrl || baseUrl + '/opensearch.xml')}" type="application/opensearchdescription+xml"/>
`;

const bookEntry = (book, baseUrl, lang) => {
  const t = getTranslation(lang);
  const author = book.author || getTranslation(lang, 'book.unknown_author');
  const title = book.title || getTranslation(lang, 'book.unknown_title');
  
  return `
  <entry>
    <title>${escapeXml(title)}</title>
    <author><name>${escapeXml(author)}</name></author>
    <id>urn:md5:${book.md5}</id>
    <updated>${(book.modified ? new Date(book.modified) : new Date()).toISOString()}</updated>
    ${book.publisher ? `<dc:publisher>${escapeXml(book.publisher)}</dc:publisher>` : ''}
    ${book.year ? `<dc:date>${book.year}</dc:date>` : ''}
    ${book.languages ? `<dc:language>${escapeXml(book.languages)}</dc:language>` : ''}
    ${book.description ? `<summary type="html">${escapeXml(book.description)}</summary>` : ''}
    ${book.coverUrl ? `<link rel="http://opds-spec.org/image" href="${escapeXml(book.coverUrl)}"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="${escapeXml(book.coverUrl)}"/>` : ''}
        <link rel="http://opds-spec.org/acquisition/"
          href="${baseUrl}/download/${book.md5}?resolve=true"
          type="${inferMimeForBook(book)}"/>
    ${book.tags ? book.tags.map(tag => `<category term="${escapeXml(tag)}"/>`).join('') : ''}
  </entry>`;
};

const generateRootCatalog = (baseUrl) => {
  console.log('[CATALOG] Generating root catalog');
  
  let xml = feedHeader('Anna\'s Library OPDS', 'urn:opds:root', baseUrl, `${baseUrl}/opds`);
  
  ['en', 'fr'].forEach(langCode => {
    const langTitle = langCode === 'fr' ? getTranslation(langCode, 'lang.fr_title') : getTranslation(langCode, 'lang.en_title');
    const langDesc = langCode === 'fr' ? getTranslation(langCode, 'lang.fr_desc') : getTranslation(langCode, 'lang.en_desc');
    
    xml += `
  <entry>
    <title>${escapeXml(langTitle)}</title>
    <id>urn:opds:${langCode}</id>
    <updated>${new Date().toISOString()}</updated>
    <content type="text">${escapeXml(langDesc)}</content>
    <link rel="subsection" href="${baseUrl}/opds/${langCode}" 
          type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  </entry>`;
  });
  
  return xml + '</feed>';
};

const generateBooksFeed = (books, baseUrl, query, id = 'urn:opds:search', searchUrl = null, lang = 'en', category = null, content = null, page = 1, hasNext = false) => {
  const displayQuery = (category ? getTranslation(lang, `categories.${category}`) || category : query) || '';
  const feedTitle = getTranslation(lang, 'search.results') + (displayQuery ? `: ${displayQuery}` : '');
  console.log(`[CATALOG] Content type catalog: ${lang ? lang : 'en'}/${content ? content : 'all'}/${category ? category : 'all'}/${page ? page : 1}`);
  console.log(`[CATALOG] Books feed: ${feedTitle} (${books.length} books)`);
  let xml = feedHeader(feedTitle, id, baseUrl, `${baseUrl}/opds/search`, searchUrl);

  if (page > 1) {
      if (content === 'popular') {
          xml += `  <link rel="previous" href="${baseUrl}/opds/${lang}/popular?page=${page - 1}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>\n`;
      } else {
          const searchData = {
              q: query || '',
              lang: lang || '',
              content: content || '',
              category: category || '',
              page: page - 1
          };
          const encodedData = encodeURIComponent(JSON.stringify(searchData));
          xml += `  <link rel="previous" href="${baseUrl}/opds/search?data=${encodedData}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>\n`;
      }
  }

  if (hasNext) {
      if (content === 'popular') {
          xml += `  <link rel="next" href="${baseUrl}/opds/${lang}/popular?page=${page + 1}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>\n`;
      } else {
          const searchData = {
              q: query || '',
              lang: lang || '',
              content: content || '',
              category: category || '',
              page: page + 1
          };
          const encodedData = encodeURIComponent(JSON.stringify(searchData));
          xml += `  <link rel="next" href="${baseUrl}/opds/search?data=${encodedData}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>\n`;
      }
  }
  
  books.forEach(book => xml += bookEntry(book, baseUrl, lang));
  return xml + '</feed>';
};

const generateLanguageCatalog = (baseUrl, langCode) => {
  console.log(`[CATALOG] Language catalog: ${langCode}`);
  const langTitle = langCode === 'fr' ? getTranslation(langCode, 'lang.fr_title') : getTranslation(langCode, 'lang.en_title');
  const searchUrl = `${baseUrl}/opensearch.xml?lang=${langCode}`;
  
  let xml = feedHeader(langTitle, `urn:opds:${langCode}`, baseUrl, 
                        `${baseUrl}/opds/${langCode}`, searchUrl);

  // Add "Most Popular" entry
  const popularTitle = getTranslation(langCode, 'opds.popular');
  xml += `
  <entry>
    <title>${escapeXml(popularTitle)}</title>
    <id>urn:opds:${langCode}:popular</id>
    <updated>${new Date().toISOString()}</updated>
    <content type="text">${escapeXml(popularTitle)}</content>
    <link rel="subsection" href="${baseUrl}/opds/${langCode}/popular" 
          type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  </entry>`;

  // Add "All" entry
  const allTitle = getTranslation(langCode, 'filter.all');
  xml += `
  <entry>
    <title>${escapeXml(allTitle)}</title>
    <id>urn:opds:${langCode}:all</id>
    <updated>${new Date().toISOString()}</updated>
    <content type="text">${escapeXml(allTitle)}</content>
    <link rel="subsection" href="${baseUrl}/opds/${langCode}/all" 
          type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  </entry>`;

  CONTENT_TYPES.forEach(contentType => {
    const contentTypeName = getTranslation(langCode, `content.${contentType}`) || contentType;
    xml += `
  <entry>
    <title>${escapeXml(contentTypeName)}</title>
    <id>urn:opds:${langCode}:${contentType}</id>
    <updated>${new Date().toISOString()}</updated>
    <content type="text">${escapeXml(contentTypeName)}</content>
    <link rel="subsection" href="${baseUrl}/opds/${langCode}/${contentType}" 
          type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  </entry>`;
  });
  
  return xml + '</feed>';
};

const generateContentTypeCatalog = (baseUrl, langCode, contentType) => {
  console.log(`[CATALOG] Content type catalog: ${langCode}/${contentType}`);
  
  // Handle special cases for "all" and "popular"
  let contentTypeName;
  if (contentType === 'all') {
    contentTypeName = getTranslation(langCode, 'filter.all');
  } else if (contentType === 'popular') {
    contentTypeName = getTranslation(langCode, 'opds.popular');
  } else {
    contentTypeName = getTranslation(langCode, `content.${contentType}`) || contentType;
  }
  
  const displayTitle = `${contentTypeName} (${langCode.toUpperCase()})`;
  const searchUrl = `${baseUrl}/opensearch.xml?lang=${langCode}&content=${contentType}`;
  
  let xml = feedHeader(displayTitle, `urn:opds:${langCode}:${contentType}`, baseUrl, 
                        `${baseUrl}/opds/${langCode}/${contentType}`, searchUrl);

  const categories = getTranslation(langCode, 'categories') || {};
  const allTitle = getTranslation(langCode, 'filter.all');
  
  // "All" entry for this content type
  xml += `
    <entry>
      <title>${escapeXml(allTitle)} ${escapeXml(contentTypeName)}</title>
      <id>urn:opds:search:${langCode}:${contentType}:all</id>
      <updated>${new Date().toISOString()}</updated>
      <content type="text">${escapeXml(allTitle)} ${escapeXml(contentTypeName)}</content>
      <link rel="search" href="${baseUrl}/opensearch.xml?lang=${langCode}&amp;content=${contentType}" type="application/opensearchdescription+xml"/>
      <link rel="subsection" href="${baseUrl}/opds/search?q=&amp;lang=${langCode}&amp;content=${contentType}" 
            type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
    </entry>`;

  CATEGORIES.forEach(category => {
    const categoryName = categories[category] || category;
    const hasSubcategories = SUBCATEGORIES[category];
    
    if (hasSubcategories) {
       // Navigation entry for category with subcategories
       xml += `
    <entry>
      <title>${escapeXml(categoryName)}</title>
      <id>urn:opds:nav:${langCode}:${contentType}:${category}</id>
      <updated>${new Date().toISOString()}</updated>
      <content type="text">${escapeXml(categoryName)}</content>
      <link rel="subsection" href="${baseUrl}/opds/${langCode}/${contentType}/${category}" 
            type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
    </entry>`;
    } else {
        // Standard acquisition/search entry
        xml += `
    <entry>
      <title>${escapeXml(categoryName)}</title>
      <id>urn:opds:search:${langCode}:${contentType}:${category}</id>
      <updated>${new Date().toISOString()}</updated>
      <content type="text">${escapeXml(categoryName)}</content>
      <link rel="search" href="${baseUrl}/opensearch.xml?lang=${langCode}&amp;content=${contentType}&amp;category=${encodeURIComponent(category)}" type="application/opensearchdescription+xml"/>
      <link rel="subsection" href="${baseUrl}/opds/search?q=${encodeURIComponent(category)}&amp;lang=${langCode}&amp;content=${contentType}&amp;category=${encodeURIComponent(category)}" 
            type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
    </entry>`;
    }
  });
  
  return xml + '</feed>';
};

const generateCategoryCatalog = (baseUrl, langCode, contentType, categoryId) => {
  console.log(`[CATALOG] Category catalog: ${langCode}/${contentType}/${categoryId}`);
  const categories = getTranslation(langCode, 'categories') || {};
  const categoryName = categories[categoryId] || categoryId;
  const allTitle = getTranslation(langCode, 'filter.all');
  
  const displayTitle = `${categoryName} (${langCode.toUpperCase()})`;
  const searchUrl = `${baseUrl}/opensearch.xml?lang=${langCode}&content=${contentType}&category=${encodeURIComponent(categoryId)}`;
  
  let xml = feedHeader(displayTitle, `urn:opds:${langCode}:${contentType}:${categoryId}`, baseUrl, 
                        `${baseUrl}/opds/${langCode}/${contentType}/${categoryId}`, searchUrl);

  // "All" entry for this category
  xml += `
    <entry>
      <title>${escapeXml(allTitle)} ${escapeXml(categoryName)}</title>
      <id>urn:opds:search:${langCode}:${contentType}:${categoryId}:all</id>
      <updated>${new Date().toISOString()}</updated>
      <content type="text">${escapeXml(allTitle)} ${escapeXml(categoryName)}</content>
      <link rel="search" href="${baseUrl}/opensearch.xml?lang=${langCode}&amp;content=${contentType}&amp;category=${encodeURIComponent(categoryId)}" type="application/opensearchdescription+xml"/>
      <link rel="subsection" href="${baseUrl}/opds/search?q=${encodeURIComponent(categoryId)}&amp;lang=${langCode}&amp;content=${contentType}&amp;category=${encodeURIComponent(categoryId)}" 
            type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
    </entry>`;

  const subCategories = SUBCATEGORIES[categoryId] || [];
  
  subCategories.forEach(subCatId => {
    const subCatName = categories[subCatId] || subCatId;
    
    xml += `
    <entry>
      <title>${escapeXml(subCatName)}</title>
      <id>urn:opds:search:${langCode}:${contentType}:${subCatId}</id>
      <updated>${new Date().toISOString()}</updated>
      <content type="text">${escapeXml(subCatName)}</content>
      <link rel="search" href="${baseUrl}/opensearch.xml?lang=${langCode}&amp;content=${contentType}&amp;category=${encodeURIComponent(subCatId)}" type="application/opensearchdescription+xml"/>
      <link rel="subsection" href="${baseUrl}/opds/search?q=${encodeURIComponent(subCatId)}&amp;lang=${langCode}&amp;content=${contentType}&amp;category=${encodeURIComponent(subCatId)}" 
            type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
    </entry>`;
  });

  return xml + '</feed>';
};

const generateOpenSearch = (baseUrl, lang = null, contentType = null, category = null) => {
  console.log(`[CATALOG] OpenSearch (lang: ${lang}, content: ${contentType}, category: ${category})`);
  const shortName = getTranslation(lang, 'opds.short_name');
  const description = getTranslation(lang, 'opds.description');
  
  let suffix = '';
  if (lang) suffix += ` (${lang.toUpperCase()})`;
  if (contentType) {
    const contentTypeName = getTranslation(lang, `content.${contentType}`) || contentType;
    suffix += ` - ${contentTypeName}`;
  }
  if (category) {
    const categories = getTranslation(lang, 'categories') || {};
    const categoryName = categories[category] || category;
    suffix += ` - ${categoryName}`;
  }
  
  const langParam = lang ? `&amp;lang=${lang}` : '';
  const contentParam = contentType ? `&amp;content=${contentType}` : '';
  const categoryParam = category ? `&amp;category=${encodeURIComponent(category)}` : '';
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="${NAMESPACES.OPENSEARCH}">
  <ShortName>${escapeXml(shortName + suffix)}</ShortName>
  <Description>${escapeXml(description + suffix)}</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <OutputEncoding>UTF-8</OutputEncoding>
  <Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" 
       template="${baseUrl}/opds/search?q={searchTerms}${langParam}${contentParam}${categoryParam}"/>
</OpenSearchDescription>`;
};

module.exports = {
  generateRootCatalog,
  generateBooksFeed,
  generateLanguageCatalog,
  generateContentTypeCatalog,
  generateCategoryCatalog,
  generateOpenSearch,
  escapeXml,
  SUBCATEGORIES
};