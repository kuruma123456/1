const express = require('express');
const path = require('path');
const fs = require('fs');
const promisify = require('util').promisify;
const asyncHandler = require('express-async-handler');

const readFile = promisify(fs.readFile);
const statFile = promisify(fs.stat);

const fileTypes = require('./types');
const hosts = require('./hosts');

// We need to make sure that all the roots have a trailing / to ensure that the path traversal prevention works properly.
// Otherwise a root of "/var/www" would allow someone to read files in /var/www-top-secret-do-not-read
for (const hostname of Object.keys(hosts)) {
  const host = hosts[hostname];
  host.root = path.join(host.root, '/');
}
// Set optional properties
for (const fileTypeName of Object.keys(fileTypes)) {
  const fileType = fileTypes[fileTypeName];
  if (!fileType.encodings) fileType.encodings = [];
}
console.log(`Known hosts: ${Object.keys(hosts).join(', ')}`)
console.log(`Known file types: ${Object.keys(fileTypes).join(', ')}`)

const app = express();
app.set('x-powered-by', false);
app.set('etag', 'strong');
app.set('case sensitive routing', false);
app.set('strict routing', false);

const safeJoin = (root, file) => {
  const newPath = path.join(root, file);
  // We need to make sure to check for path traversal exploits.
  if (newPath.indexOf(root) !== 0) {
    return null;
  }
  return newPath;
};

const findFile = async (file) => {
  try {
    const stat = await statFile(file);
    if (stat.isDirectory()) {
      const indexFile = path.join(file, 'index.html');
      const indexStat = await statFile(indexFile);
      if (indexStat.isFile()) {
        return {
          path: indexFile,
          stat: indexStat
        };
      }
    } else if (stat.isFile()) {
      return {
        path: file,
        stat
      };
    }
  } catch (e) {
    // File does not exist.
  }
  return null;
};

const getFileType = (file) => {
  const extensionName = path.extname(file);
  if (!fileTypes.hasOwnProperty(extensionName)) {
    return null;
  }
  return fileTypes[extensionName];
};

const chooseEncoding = async (acceptedEncodings, fileEncodings, filePath) => {
  // Encodings are checked in the order they are specified.
  for (const encoding of fileEncodings) {
    const name = encoding.name;
    if (acceptedEncodings.indexOf(name) === -1) {
      // This encoding is not supported.
      continue;
    }

    const encodedFilePath = `${filePath}.${encoding.extension}`;
    try {
      const encodedFileStat = await statFile(encodedFilePath);
      if (encodedFileStat.isFile()) {
        return {
          name,
          path: encodedFilePath,
          stat: encodedFileStat
        };
      }
    } catch (e) {
      // The file for this encoding does not exist, keep checking others.
    }
  }

  // No alternative encodings supported.
  return null;
};

app.use((req, res, next) => {
  const hostname = req.hostname;
  if (!hosts.hasOwnProperty(hostname)) {
    res.status(400);
    res.contentType('text/plain');
    res.send('Invalid Host');
    return;
  }

  const host = hosts[hostname];
  const branches = host.branches;

  let path = req.path;
  let prefix = '';

  if (branches) {
    const branchMatch = path.match(/^\/([\w\d_-]+)\//);
    if (branchMatch) {
      const branchName = branchMatch[1];
      prefix = `/${branchName}`;
      path = path.substring(prefix.length);
    }
  }

  if (/^\/(?:\d+\/?)?$/.test(path)) {
    req.logicalPath = `${prefix}/index.html`;
  } else if (/^\/(?:\d+\/)?editor\/?$/i.test(path)) {
    req.logicalPath = `${prefix}/editor.html`;
  } else if (/^\/(?:\d+\/)?fullscreen\/?$/i.test(path)) {
    req.logicalPath = `${prefix}/fullscreen.html`;
  }

  req.root = host.root;

  next();
});

app.get('/js/*', (req, res, next) => {
  // File names contain hash of content, can cache forever.
  res.header('Cache-Control', 'public, max-age=315360000, immutable');
  next();
});
app.get('/static/assets/*', (req, res, next) => {
  // File names contain hash of content, can cache forever.
  res.header('Cache-Control', 'public, max-age=315360000, immutable');
  next();
});
app.get('/static/blocks-media/*', (req, res, next) => {
  // File names don't contain hash of content, but these files are hot and will rarely change.
  res.header('Cache-Control', 'public, max-age=3600, immutable');
  next();
});

app.get('/*', asyncHandler(async (req, res, next) => {
  const pathName = req.logicalPath || req.path;

  if (/[^a-zA-Z0-9.\-\/~]/.test(pathName)) {
    next();
    return;
  }

  const requestPathName = safeJoin(req.root, pathName);
  if (!requestPathName) {
    next();
    return;
  }

  let {path: filePath, stat: fileStat} = await findFile(requestPathName);
  if (!filePath) {
    next();
    return;
  }

  const fileLastModified = fileStat.mtime;

  const fileType = getFileType(filePath);
  if (fileType === null) {
    next();
    return;
  }

  let contentEncoding = null;
  const fileEncodings = fileType.encodings;
  if (fileEncodings.length > 0) {
    const acceptedEncodings = req.acceptsEncodings();
    const bestEncoding = await chooseEncoding(acceptedEncodings, fileEncodings, filePath);
    if (bestEncoding !== null) {
      filePath = bestEncoding.path;
      contentEncoding = bestEncoding.name;
    }
  }

  let contents;
  try {
    // We read the entire file into memory as a buffer
    // I know that a stream would be more memory efficient, but reading the file like this
    // sets Content-Length and ETag properly without worry of race conditions.
    contents = await readFile(filePath);
  } catch (e) {
    // File does not exist. This is possible if a race condition occurs between when we found the file and when we read the file.
    next();
    return;
  }

  // Don't send headers until the end
  // If we went them earlier, it's possible to have Content-Encoding set incorrectly for a plaintext error message sent later.
  res.setHeader('Content-Type', fileType.type);
  res.setHeader('Last-Modified', fileLastModified.toUTCString());
  if (contentEncoding !== null) {
    res.setHeader('Content-Encoding', contentEncoding);
  }
  // If there are multiple versions of this file, make sure that proxies won't send the wrong encoding to clients.
  if (fileEncodings.length > 0) {
    res.setHeader('Vary', 'Accept-Encoding');
  }

  // Force browsers to revalidate all files that aren't explicitly cached
  if (res.getHeader('Cache-Control') === undefined) {
    res.setHeader('Cache-Control', 'no-cache');
  }

  res.send(contents);
}));

app.use((req, res) => {
  res.status(404);
  res.contentType('text/plain');
  res.send('404 Not Found');
});

app.use((err, req, res, next) => {
  // Do not log errors in production, as it may be possible for someone to abuse console.error's sync behaviors to DoS
  if (app.get('env') === 'development') {
    console.error(err);
  }
  res.status(500);
  res.contentType('text/plain');
  res.send('Internal server error');
});

app.listen(process.env.PORT || 8888);
