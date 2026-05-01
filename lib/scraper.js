require('dotenv').config();

const cheerio = require('cheerio');
const { SUBCATEGORIES } = require('./catalog');
const { getDomain, refreshDomain } = require('./domains');
const cache = require('./cache');

// List all file extensions from the HTML
const FILE_EXTENSIONS = [
  'pdf', 'epub', 'mobi', 'zip', 'fb2', 'cbr', 'txt', 'djvu', 'cbz', 'azw3',
  'doc', 'lit', 'rtf', 'rar', 'htm', 'html', 'mht', 'docx', 'lrf', 'jpg',
  'chm', 'azw', 'pdb', 'odt', 'ppt', 'xls', 'xlsx', 'json', 'prc', 'tar',
  'tif', 'snb', 'updb', 'htmlz', '7z', 'cb7', 'gz', 'pptx', 'exe', 'ai'
];

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

/**
 * Helper to perform a request with automatic domain failover.
 * FlareSolverr is NOT used here to avoid overhead on general searches.
 * @param {string} service - 'annas' or 'zlib'
 * @param {function} urlBuilder - Function that takes (domain) and returns full URL
 * @returns {Promise<Response>}
 */
async function requestWithRetry(service, urlBuilder, options = {}) {
  let domain = getDomain(service);
  let url = urlBuilder(domain);
  
  const performRequest = async (targetUrl) => {
    return fetch(targetUrl, { 
      ...options,
      headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) } 
    });
  };

  try {
    const response = await performRequest(url);
    if (response.status === 403 || response.status >= 500) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  } catch (error) {
    console.warn(`[${service.toUpperCase()}] Direct request failed (${error.message}). Trying failover...`);
    
    try {
      domain = await refreshDomain(service);
      url = urlBuilder(domain);
      const failoverResponse = await performRequest(url);
      if (failoverResponse.status === 403 || failoverResponse.status >= 500) {
        throw new Error(`HTTP ${failoverResponse.status}`);
      }
      return failoverResponse;
    } catch (failoverError) {
      console.error(`[${service.toUpperCase()}] All direct methods failed: ${failoverError.message}`);
      // Return a mock failed response
      return { ok: false, status: 503, text: async () => '' };
    }
  }
}

/**
 * Search Anna's Archive for books
 * @param {string} query - Search query
 * @param {string} [lang] - Language code (e.g., 'en', 'fr')
 * @param {string|string[]} [content] - Content type(s)
 * @param {string} [category] - Category
 * @param {number} [page=1] - Page number
 * @returns {Promise<Array>} Array of book objects
 */
async function searchBooks(query, lang, content, category, page = 1) {

  // Handle category expansion using SUBCATEGORIES map
  let fullQuery = query;
  
  if (category) {
    if (SUBCATEGORIES[category]) {
      // If the category has subcategories, construct OR query
      const subCats = SUBCATEGORIES[category];
      const categoriesQuery = subCats.map(cat => `"${cat}"`).join('||');
      
      // If query already exists, append with space, else just use categories
      if (query && query.trim() !== '') {
        fullQuery = `${query} ${categoriesQuery}`;
      } else {
        fullQuery = categoriesQuery;
      }
    } else if (!query.includes(category)) {
      // Standard single category
      fullQuery = query && query.trim() !== '' ? `${query} ${category}` : category;
    }
  }

  const urlBuilder = (domain) => {
    let searchUrl = `https://${domain}/search?q=${encodeURIComponent(fullQuery)}`;
    if (lang) searchUrl += `&lang=${lang}`;
    if (content && content !== 'all') searchUrl += `&content=${content}`;
    if (page > 1) searchUrl += `&page=${page}`;
    return searchUrl;
  };

  try {
    const response = await requestWithRetry('annas', urlBuilder);

    if (!response.ok) {
      console.error(`[SEARCH] HTTP error: ${response.status}`);
      return [];
    }

    const html = await response.text();
    // Use the domain from the module state as it might have been updated
    return parseSearchResults(html, getDomain('annas'));
  } catch (error) {
    console.error(`[SEARCH] Error: ${error.message}`);
    return [];
  }
}

/**
 * Parse search results HTML to extract book information
 * @param {string} html - HTML content
 * @param {string} domain - Base domain for constructing links
 * @returns {Array} Array of book objects
 */
function parseSearchResults(html, domain) {
  const $ = cheerio.load(html);
  const books = [];

  // Find each book result container
  const $partial = $('div.italic.mt-4.mb-1.text-sm.font-bold:contains("partial match")').first();
  $('div.pt-3').filter((i, el) => {
      if (!$partial.length) return true;
      
      // Check if partial matches element is NOT in the previous elements of current element
      return $(el).prevAll().addBack().index($partial[0]) === -1;
  }).each((index, element) => {
    const $el = $(element);
    
    // Extract cover image URL
    const coverImg = $el.find('img[src^="http"]').attr('src');
    const fallbackCover = $el.find('.js-aarecord-list-fallback-cover');
    const titleFromFallback = fallbackCover.find('div[data-content]:first-child').attr('data-content') || '';
    const authorFromFallback = fallbackCover.find('div[data-content]:nth-child(2)').attr('data-content') || '';
    
    // Extract book link and MD5
    const bookLink = $el.find('a[href^="/md5/"]').attr('href');
    if (!bookLink) return;
    
    const md5 = bookLink.replace('/md5/', '');
    
    // Extract title from multiple possible locations
    const titleElement = $el.find('a[href^="/md5/"]').eq(1); // Second link with title
    const title = titleElement.text().trim() || titleFromFallback || 'Unknown Title';
    // Extract author
    const authorElement = $el.find('a[href^="/search?q="]').eq(0);
    const author = authorElement.text().trim() || authorFromFallback || 'Unknown Author';
    
    // Extract publisher and year
    const publisherElement = $el.find('a[href^="/search?q="]').eq(1);
    let publisher = '';
    let year = '';
    if (publisherElement.length) {
      const publisherText = publisherElement.text().trim();
      // Try to extract year from publisher text (e.g., "Bragelonne, 2014")
      const yearMatch = publisherText.match(/(\d{4})$/);
      if (yearMatch) {
        year = yearMatch[1];
        publisher = publisherText.replace(/, \d{4}$/, '').trim();
      } else {
        publisher = publisherText;
      }
    }
    
    // Extract file info from the text description
    const infoText = $el.find('div.text-gray-800, div.text-slate-400').first().text().trim();
    
    // Parse language, format, size, year (again), and type from info text
    let languages = '';
    let format = '';
    let size = '';
    let tags = [];
    
    if (infoText) {
      // Extract language (e.g., "French [fr]")
      const langMatches = infoText.matchAll(/([\w\s]+)\s*\[(\w+)\]/g);
      languages = [...langMatches].map(m => m[1].trim()).join(', ').toUpperCase();
      
      // Extract format (e.g., "EPUB", "PDF", etc.)
      const formatMatch = infoText.match(/\b(EPUB|PDF|MOBI|AZW3|AZW|DOC|DOCX|RTF|TXT|CBZ|CBR)\b/i);
      if (formatMatch) {
        format = formatMatch[1].toUpperCase();
      }
      
      // Extract size (e.g., "0.6MB")
      const sizeMatch = infoText.match(/(\d+(?:\.\d+)?)\s*(MB|KB|GB)/i);
      if (sizeMatch) {
        size = `${sizeMatch[1]}${sizeMatch[2].toUpperCase()}`;
      }
      
      // Extract year if not already found
      if (!year) {
        const yearMatch = infoText.match(/\b(19|20)\d{2}\b/);
        if (yearMatch) {
          year = yearMatch[0];
        }
      }

      tags.push(size);
      tags.push(format);
    }
    
    // Extract original file path
    const filePath = $el.find('div.text-gray-500.font-mono').text().trim();
    
    // Extract description/summary
    const description = $el.find('div:nth-child(2) > div:nth-child(2) > div:nth-child(2) > div:nth-child(1)').text().trim();
    
    // Extract upload date from the timestamp in cover image
    let uploadDate = '';
    const dateElement = $el.find('span[title="Download time"]');
    if (dateElement.length) {
      uploadDate = dateElement.text().trim();
    }
    
    // Get MIME type based on format
    const mimeType = getMimeType(format);
    
    // Extract source (e.g., "🚀/lgli/zlib")
    let source = '';
    const sourceMatch = infoText.match(/🚀\/([^·]+)/);
    if (sourceMatch) {
      source = sourceMatch[1].trim();
    }
    
    // Avoid duplicates
    const existingBook = books.find(b => b.md5 === md5);
    if (!existingBook) {
      books.push({
        id: md5,
        md5,
        title,
        author,
        publisher,
        year,
        languages,
        format,
        size,
        tags,
        description,
        coverUrl: coverImg || null,
        filePath,
        source,
        uploadDate,
        downloadUrl: `https://${domain}/md5/${md5}`,
        mimeType,
        modified: new Date()
      });
    }
  });

  return books;
}

// Helper function to determine MIME type
function getMimeType(format) {
  const mimeTypes = {
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
  return mimeTypes[format.toUpperCase()] || 'application/octet-stream';
}

/**
 * Resolve a Zlib ID to an Anna's Archive MD5
 * @param {string} zlibId - The Zlib numeric ID
 * @returns {Promise<string|null>} Resolved MD5
 */
async function resolveZlibIdToMd5(zlibId) {
  const urlBuilder = (domain) => `https://${domain}/search?q=${encodeURIComponent(`"zlib:${zlibId}"`)}` ;
  console.log(`[RESOLVE] Resolving Zlib ID ${zlibId}`);
  
  try {
    const response = await requestWithRetry('annas', urlBuilder);
    if (!response.ok) return null;
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Find each book result container and skip partial matches
    const $partial = $('div.italic.mt-4.mb-1.text-sm.font-bold:contains("partial match")').first();
    const bookLink = $('div.pt-3').filter((i, el) => {
        if (!$partial.length) return true;
        // Check if partial matches element is NOT in the previous elements of current element
        return $(el).prevAll().addBack().index($partial[0]) === -1;
    }).find('a[href^="/md5/"]').first().attr('href');

    if (bookLink) {
      const md5 = bookLink.replace('/md5/', '');
      console.log(`[RESOLVE] Resolved ${zlibId} to MD5: ${md5}`);
      return md5;
    }
    
    console.warn(`[RESOLVE] Could not find MD5 for Zlib ID: ${zlibId}`);
    return null;
  } catch (error) {
    console.error(`[RESOLVE] Error: ${error.message}`);
    return null;
  }
}

async function mapZlibBook(book, detailBook = null, tag = 'Popular on Zlib') {
  const db = detailBook || book;
  
  // Get MD5: prefer db.md5, fallback to resolving zlibId
  let md5 = db.md5;
  if (!md5 && book.id) {
    md5 = await resolveZlibIdToMd5(book.id);
  }
  
  // Only return book if we have a real MD5
  if (!md5) {
    console.warn(`[MAP] Skipping book ${book.id} - no real MD5 available`);
    return null;
  }
  
  const formatVal = db.extension ? db.extension.toUpperCase() : 'UNKNOWN';
  return {
    id: book.id,
    md5,
    title: db.title || book.title,
    author: db.author || book.author,
    coverUrl: db.cover || book.cover,
    year: db.year?.toString() || '',
    languages: db.language || 'UNKNOWN',
    format: formatVal,
    mimeType: getMimeType(formatVal),
    size: db.filesizeString || '',
    pages: db.pages || 0,
    description: db.description || book.description || '',
    tags: [tag, db.filesizeString, formatVal].filter(Boolean),
    zlibId: book.id || null,
    zlibHash: book.hash || null,
    modified: new Date()
  };
}

async function getPopularBooks(langCode, page = 1) {
  const cacheKey = `popular_${langCode}`;
  const CACHE_TTL = 3600000; // 1 hour
  let allBooks = [];
  
  try {
    // Try to get from cache
    const cachedBooks = await cache.get(cacheKey);
    if (cachedBooks) {
      console.log(`[POPULAR] Using cached data for ${langCode}`);
      allBooks = cachedBooks;
    } else {
      // Fetch from API
      const urlBuilder = (domain) => `https://${langCode}.${domain}/eapi/book/most-popular`;
      try {
        const response = await requestWithRetry('zlib', urlBuilder);
        const text = await response.text();
        
        // Check for rate limiting
        if (text && (text.includes('Too many requests') || text.includes('too many requests'))) {
          console.warn(`[ZLIB] Rate limited while fetching popular books for ${langCode}`);
          return { books: [], nextPage: null, error: 'rate_limit' };
        }
        
        if (response.ok) {
          let data;
          try { 
            data = JSON.parse(text); 
          } catch (e) {
            console.error(`[ZLIB] Error parsing popular list: ${text.substring(0, 30)}...`);
          }
          
          if (data && data.success && data.books) {
            allBooks = data.books;
            // Cache the fetched data
            await cache.set(cacheKey, allBooks, CACHE_TTL);
            console.log(`[POPULAR] Cached ${allBooks.length} books for ${langCode}`);
          }
        }
      } catch (error) {
        console.error(`[ZLIB] Error fetching popular: ${error.message}`);
      }
    }
  } catch (cacheError) {
    console.error(`[CACHE] Error accessing cache:`, cacheError.message);
  }

  if (allBooks.length === 0) return { books: [], nextPage: null };

  const itemsPerPage = 50;
  const startIndex = (page - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedBooks = allBooks.slice(startIndex, endIndex);
  const hasNextPage = endIndex < Math.min(allBooks.length, 100);
  
  const detailedBooks = await Promise.all(paginatedBooks.map(async (book) => {
    const bookDetailCacheKey = `book_detail_${book.id}`;
    const BOOK_DETAIL_TTL = 86400000; // 24 hours
    
    try {
      // Try cache first
      const cachedDetail = await cache.get(bookDetailCacheKey);
      if (cachedDetail) {
        return cachedDetail;
      }
      
      // Fetch detail
      const detailUrlBuilder = (domain) => `https://${langCode}.${domain}/eapi/book/${book.id}/${book.hash}`;
      const detailResponse = await requestWithRetry('zlib', detailUrlBuilder);
      const detailText = await detailResponse.text();
      
      // Check for rate limiting
      if (detailText && (detailText.includes('Too many requests') || detailText.includes('too many requests'))) {
        console.warn(`[ZLIB] Rate limited fetching detail for book ${book.id}`);
        return await mapZlibBook(book, null);
      }
      
      if (detailResponse.ok) {
        let detailData;
        try {
          detailData = JSON.parse(detailText);
        } catch (err) {
          // silently catch JSON parse error typical of rate limiting HTML response
        }
        
        if (detailData && detailData.success && detailData.book) {
          const mapped = await mapZlibBook(book, detailData.book);
          if (mapped) {
            await cache.set(bookDetailCacheKey, mapped, BOOK_DETAIL_TTL);
            return mapped;
          }
          return null;
        }
      }
    } catch (e) {
      console.error(`[POPULAR] Error fetching detail for book ${book.id}:`, e.message);
    }
    
    // Fallback
    return await mapZlibBook(book);
  })).then(books => books.filter(b => b !== null));
  
  return {
    books: detailedBooks,
    nextPage: hasNextPage ? parseInt(page) + 1 : null
  };
}

async function getBookDetails(md5) {
  const urlBuilder = (domain) => `https://${domain}/md5/${md5}`;

  try {
    const response = await requestWithRetry('annas', urlBuilder);

    if (!response.ok) {
      console.error(`[BOOK] HTTP error: ${response.status}`);
      return null;
    }

    const html = await response.text();
    return parseBookDetails(html, md5, getDomain('annas'));
  } catch (error) {
    console.error(`[BOOK] Error: ${error.message}`);
    return null;
  }
}

/**
 * Parse book details page for download links
 */
function parseBookDetails(html, md5, domain) {
  const $ = cheerio.load(html);
  
  // Get title from page
  const title = $('div.font-semibold:nth-child(4)').first().text().trim() || 'Unknown Title';
  
  // Find download links - Anna's Archive has various mirror links
  const downloadLinks = [];

  // Extract Z-Library ID from tabs
  let zlibId = '';
  $('a.js-md5-codes-tabs-tab').each((_, tab) => {
    const $tab = $(tab);
    const label = $tab.find('span:first-child').text();
    if (label.includes('Z-Library')) {
      zlibId = $tab.find('span:nth-child(2)').text().trim().split(' ')[0];
    }
  });
  console.log(`[ANNA] Extracted from tabs - zlibId: ${zlibId}`);

  $('a.js-download-link').each((i, el) => {
    const $link = $(el);
    const href = $link.attr('href');
    const text = $link.text();
    const parentText = $link.parent().text();
    
    // Only include links that have "(no waitlist" in the parent li text
    if (href && href.includes('/slow_download/') && parentText.includes('(no waitlist')) {
      const fullUrl = `https://${domain}${href}`;
      
      downloadLinks.push({
        url: fullUrl,
        text: text,
        isWaitlist: false
      });
    }
  });
  
  // If no "no waitlist" links found, fall back to any slow_download link
  if (downloadLinks.length === 0) {
    console.log(`[ANNA] No "no waitlist" links found, falling back to external download`);
  }

  console.log(`[BOOK] Found ${downloadLinks.length} download links for: ${title}`);
  
  return {
    md5,
    title,
    downloadLinks,
    zlibId,
    pageUrl: `https://${domain}/md5/${md5}`
  };
}

/**
 * Get actual download link using FlareSolverr to bypass Cloudflare
 * @param {string} slowDownloadUrl - The "slow" download page URL
 * @returns {Promise<string|null>} Direct download URL
 */
async function getActualDownloadLink(slowDownloadUrl) {
  console.log(`[FLARESOLVERR] Requesting: ${slowDownloadUrl.url}`);
  
  try {
    const response = await fetch(process.env.FLARESOLVERR_URL || 'http://localhost:32768/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cmd: 'request.get',
        url: slowDownloadUrl.url,
        maxTimeout: 60000,
      }),
    });

    if (!response.ok) {
      console.error(`[FLARESOLVERR] HTTP error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    
    if (data.status !== 'ok') {
      console.error(`[FLARESOLVERR] Error status: ${data.status}`);
      // If there's an error message, log it
      if (data.message) console.error(`[FLARESOLVERR] Message: ${data.message}`);
      return null;
    }

    const html = data.solution.response;
    const $ = cheerio.load(html);

    // Create regex pattern
    const extensionPattern = FILE_EXTENSIONS.join('|');
    const urlRegex = new RegExp(`https?://\\S+?\\.(${extensionPattern})(?:\\?\\S*)?`, 'gi');
    const hrefRegex = new RegExp(`\\.(${extensionPattern})(?:\\?|$)`, 'i');

    const downloadUrl = [
      // Text URLs
      ...($('body').text().match(urlRegex) || []),
      
      // Href URLs  
      ...($('[href*="http"]').map((_, el) => $(el).attr('href')).get()
        .filter(href => hrefRegex.test(href)))
    ][0];

    if (downloadUrl) {
      console.log(`[FLARESOLVERR] Found download link: ${downloadUrl}`);
    } else {
      console.log(`[FLARESOLVERR] No download link found with expected extension`);
    }

    return downloadUrl;
  } catch (error) {
    console.error(`[FLARESOLVERR] System Error: ${error.message}`);
    return null;
  }
}

async function getZlibBookDetails(id, hash) {
  try {
    const detailUrlBuilder = (domain) => `https://${domain}/eapi/book/${id}/${hash}`;
    const response = await requestWithRetry('zlib', detailUrlBuilder);
    if (response.ok) {
      const text = await response.text();
      return JSON.parse(text);
    }
  } catch (e) {
    // Silent fail
  }
  return { success: false };
}

async function getSimilarBooks(id, hash) {
  const cacheKey = `similar_${id}_${hash}`;
  const CACHE_TTL = 86400000; // 24 hours
  
  try {
    // Try to get from cache
    const cachedBooks = await cache.get(cacheKey);
    if (cachedBooks) {
      console.log(`[SIMILAR] Using cached data for ${id}`);
      return cachedBooks;
    }
    
    // Fetch from API
    const urlBuilder = (domain) => `https://${domain}/eapi/book/${id}/${hash}/similar`;
    const response = await requestWithRetry('zlib', urlBuilder);
    const text = await response.text();
    
    // Check for rate limiting in response text (API returns 200 with error message)
    if (text && (text.includes('Too many requests') || text.includes('too many requests'))) {
      console.warn(`[ZLIB] Rate limited: ${text.substring(0, 100)}`);
      return { error: 'rate_limit', message: 'too many requests' };
    }
    
    // Check for HTTP status-based rate limiting
    if (response.status === 429 || response.status === 503) {
      console.warn(`[ZLIB] Rate limited (${response.status}): ${response.statusText}`);
      return { error: 'rate_limit', message: 'too many requests' };
    }
    
    if (response.ok) {
      const data = JSON.parse(text);
      if (data && data.success && data.books) {
        // Fetch details for each similar book to complete information
        const detailedSimilar = (await Promise.all(data.books.slice(0, 12).map(async (book) => {
          try {
            const detailRes = await getZlibBookDetails(book.id, book.hash);
            if (detailRes && detailRes.success && detailRes.book) {
              return await mapZlibBook(book, detailRes.book, 'Similar');
            }
          } catch (e) {}
          return await mapZlibBook(book, null, 'Similar');
        }))).filter(b => b !== null);
        
        // Cache the result
        await cache.set(cacheKey, detailedSimilar, CACHE_TTL);
        console.log(`[SIMILAR] Cached ${detailedSimilar.length} books for ${id}`);
        return detailedSimilar;
      }
    }
  } catch (e) {
    console.error(`[ZLIB] Error fetching similar books: ${e.message}`);
  }
  return [];
}

async function getRecommendedBooks(id) {
  const cacheKey = `recommended_${id}`;
  const CACHE_TTL = 86400000; // 24 hours
  
  try {
    // Try to get from cache
    const cachedBooks = await cache.get(cacheKey);
    if (cachedBooks) {
      console.log(`[RECOMMENDED] Using cached data for ${id}`);
      return cachedBooks;
    }
    
    // Fetch from API
    const urlBuilder = (domain) => `https://${domain}/papi/book/recommended/mosaic/21/1`;
    const response = await requestWithRetry('zlib', urlBuilder, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookIds: [parseInt(id)] })
    });
    
    const text = await response.text();
    
    // Check for rate limiting in response text (API returns 200 with error message)
    if (text && (text.includes('Too many requests') || text.includes('too many requests'))) {
      console.warn(`[ZLIB] Rate limited: ${text.substring(0, 100)}`);
      return { error: 'rate_limit', message: 'too many requests' };
    }
    
    // Check for HTTP status-based rate limiting
    if (response.status === 429 || response.status === 503) {
      console.warn(`[ZLIB] Rate limited (${response.status}): ${response.statusText}`);
      return { error: 'rate_limit', message: 'too many requests' };
    }
    
    if (response.ok) {
      const data = JSON.parse(text);
      if (data && data.success && data.books) {
        const detailedRecommended = (await Promise.all(data.books.slice(0, 12).map(async (book) => {
          try {
            const detailRes = await getZlibBookDetails(book.id, book.hash);
            if (detailRes && detailRes.success && detailRes.book) {
              return await mapZlibBook(book, detailRes.book, 'Recommended');
            }
          } catch (e) {}
          return await mapZlibBook(book, null, 'Recommended');
        }))).filter(b => b !== null);
        
        // Cache the result
        await cache.set(cacheKey, detailedRecommended, CACHE_TTL);
        console.log(`[RECOMMENDED] Cached ${detailedRecommended.length} books for ${id}`);
        return detailedRecommended;
      }
    }
  } catch (e) {
    console.error(`[ZLIB] Error fetching recommended books: ${e.message}`);
  }
  return [];
}

module.exports = { searchBooks, getBookDetails, getActualDownloadLink, getPopularBooks, getZlibBookDetails, getSimilarBooks, getRecommendedBooks };
