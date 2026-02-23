#!/usr/bin/env python3
from flask import Flask, send_from_directory
import os
import re
import ssl

app = Flask(__name__)

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_file(path):
    safe_path = (path or '').lstrip('/')
    full_path = os.path.join('.', safe_path)

    if safe_path and os.path.isfile(full_path):
        return send_from_directory('.', safe_path)

    # Local/dev convenience: treat subset-style paths (e.g. /6_9, /9-10-11)
    # as routes to index.html so the client JS can parse the indices.
    first_segment = safe_path.split('/', 1)[0] if safe_path else ''
    is_known_page = first_segment in {'index.html', 'goodnews.html', 'about.html', '404.html'}
    looks_like_file = '.' in first_segment
    looks_like_subset = bool(first_segment) and (not looks_like_file) and (not is_known_page) and re.search(r'\d', first_segment)

    if looks_like_subset:
        return send_from_directory('.', 'index.html')

    return send_from_directory('.', safe_path)

if __name__ == '__main__':
    # HTTPS so mobile devices on the local network can use Geolocation API
    # (requires secure origin). Phone must accept the self-signed cert warning.
    cert_dir = os.path.join(os.path.expanduser('~'), 'Documents', 'lasosearch.github.io')
    ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_ctx.load_cert_chain(
        os.path.join(cert_dir, 'cert.pem'),
        os.path.join(cert_dir, 'key.pem')
    )
    app.run(host='0.0.0.0', port=8000, debug=True, ssl_context=ssl_ctx)