const { searchBooks, getBookDetails, getActualDownloadLink, getPopularBooks } = require('./scraper');
const { generateBooksFeed } = require('./catalog');
const axios = require('axios');

// Default headers to mimic a real browser when proxying remote files
const DEFAULT_REMOTE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

const getBaseUrl = (req) => `${req.protocol}://${req.get('host')}`;
const OPDS_CONTENT_TYPE = 'application/atom+xml;profile=opds-catalog';

const handleSearch = async (req, res) => {
  try {
    let { q = '', lang = '', content = '', category = '', page = 1 } = req.query;
    
    // Parse JSON data if provided
    if (req.query.data) {
      try {
        ({ q, lang, content, category, page } = JSON.parse(decodeURIComponent(req.query.data)));
      } catch (e) { 
        console.error('Parse error:', e); 
      }
    }
    
    const baseUrl = getBaseUrl(req);
    const books = await searchBooks(q, lang, content, category, +page);
    
    // Build search URL
    const params = new URLSearchParams({ lang, content, category });
    params.toString(); // Filters empty values
    
    res.set('Content-Type', OPDS_CONTENT_TYPE).send(generateBooksFeed(
      books, 
      baseUrl, 
      q,
      `urn:opds:search:${[q, lang, content, category, page > 1 ? page : ''].filter(Boolean).join(':')}`,
      `${baseUrl}/opensearch.xml${params ? '?' + params : ''}`,
      lang || 'en', 
      category, 
      content, 
      +page, 
      books.length === 50
    ));
  } catch (error) {
    console.error(`Search error: ${error.message}`);
    res.status(500).send('Search failed');
  }
};

const handlePopular = async (req, res) => {
  try {
    const { lang = 'en' } = req.params;
    const { page = 1 } = req.query;
    const baseUrl = getBaseUrl(req);
    
    const { books, nextPage } = await getPopularBooks(lang, +page);
    // Debug: log the first few books to check format/mimeType for OPDS popular feed
    try {
      console.log('[POPULAR] Sample book mime info:', books.slice(0,5).map(b => ({ md5: b.md5 || b.id, title: b.title, format: b.format, mimeType: b.mimeType })));
    } catch (e) { /* ignore */ }
    
    res.set('Content-Type', OPDS_CONTENT_TYPE).send(generateBooksFeed(
      books,
      baseUrl,
      '',
      `urn:opds:popular:${lang}:${page}`,
      null,
      lang,
      null,
      'popular',
      +page,
      !!nextPage
    ));
  } catch (error) {
    console.error(`Popular books error: ${error.message}`);
    res.status(500).send('Failed to fetch popular books');
  }
};

const handleDownload = async (req, res) => {
  let { md5 } = req.params;
  const { resolve } = req.query;

  try {
    const book = await getBookDetails(md5);
    if (book?.downloadLinks?.length) {
      const actualLink = await getActualDownloadLink(book.downloadLinks[0]);

      if (!actualLink) return res.status(502).send('Could not resolve download link');

      // If resolve=true, stream the remote file through this server using axios
      if (resolve === 'true') {
        try {
          console.log(`[STREAM] Resolving and streaming: ${actualLink}`);
          const headers = {
            ...DEFAULT_REMOTE_HEADERS,
            Referer: book?.pageUrl || actualLink,
            ...(req.headers.range ? { Range: req.headers.range } : {})
          };

          console.log('[STREAM] Initiating axios GET...');
          const remoteRes = await axios.get(actualLink, {
            responseType: 'stream',
            timeout: 0,
            maxRedirects: 5,
            headers,
            validateStatus: status => status >= 200 && status < 400
          });

          console.log(`[STREAM] axios response status=${remoteRes.status}`);
          console.log(`[STREAM] axios response headers: ${Object.keys(remoteRes.headers).filter(h=>['content-type','content-length','content-disposition','accept-ranges'].includes(h)).map(h=>`${h}=${remoteRes.headers[h]}`).join(', ')}`);

          // Forward important headers
          const headersToForward = ['content-type', 'content-length', 'content-disposition', 'accept-ranges'];
          headersToForward.forEach(h => {
            if (remoteRes.headers[h]) res.setHeader(h, remoteRes.headers[h]);
          });

          res.status(remoteRes.status);

          // Pipe the remote stream to the client
          remoteRes.data.on('error', (err) => {
            console.error(`Stream error: ${err.message}`);
            try { res.end(); } catch (e) {}
          });

          // When client aborts, destroy remote stream
          req.on('close', () => {
            if (remoteRes.data && typeof remoteRes.data.destroy === 'function') {
              remoteRes.data.destroy();
            }
          });

          console.log('[STREAM] Piping remote stream to client');
          const piped = remoteRes.data.pipe(res);
          piped.on && piped.on('finish', () => console.log('[STREAM] Pipe finished'));
          return piped;
        } catch (streamErr) {
          // If the remote server returned an HTTP error (e.g., 403), forward that status
          if (streamErr?.response && streamErr.response.status) {
            console.error(`Streaming error: Remote responded ${streamErr.response.status}`);
            return res.status(streamErr.response.status).send(`Remote server responded with ${streamErr.response.status}`);
          }

          console.error(`Streaming error: ${streamErr.message}`);
          return res.status(500).send('Error streaming the file');
        }
      }

      // Default behaviour: redirect to actual link
      return res.redirect(actualLink);
    }
    return res.status(404).send('Could not download the book');
  } catch (error) {
    console.error(`Download error: ${error.message}`);
    return res.status(500).send('Could not download the book');
  }
};

module.exports = {
  handleSearch,
  handlePopular,
  handleDownload,
  getBaseUrl,
  OPDS_CONTENT_TYPE
};
