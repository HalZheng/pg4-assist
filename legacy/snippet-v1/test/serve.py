# 用于真实站点验证：带 CORS 的静态文件服务，让 pgAdmin 页面 fetch 本地 snippet 注入
# 用法: python pg4-smart-assist-snippet/test/serve.py [port]
import http.server
import os
import sys
import urllib.parse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')


class CorsHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.abspath(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), CorsHandler)
    print(f'serving {os.path.abspath(ROOT)} at http://127.0.0.1:{port}/')
    server.serve_forever()


if __name__ == '__main__':
    main()
