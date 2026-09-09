"""Cookie-authenticated HTTP client for disposable Innkeeper rigs."""
import http.client
import json
import ssl
import io
import urllib.error
import urllib.parse

PASSWORD = 'fixture password with enough characters'

class Client:
    def __init__(self, origin):
        self.origin = origin
        self.cookie = ''
        self.csrf = ''

    def request(self, path, method='GET', body=None, headers=None):
        url = urllib.parse.urlsplit(self.origin)
        connection = (http.client.HTTPSConnection(url.netloc, context=ssl._create_unverified_context(), timeout=40)
                      if url.scheme == 'https' else http.client.HTTPConnection(url.netloc, timeout=40))
        supplied = {'Content-Type':'application/json', 'Origin':'https://' + url.netloc,
                    'Cookie':self.cookie, 'X-Innkeeper-CSRF':self.csrf}
        supplied.update(headers or {})
        data = json.dumps(body if body is not None else {}).encode() if method != 'GET' else None
        if supplied['Content-Type'] == 'application/x-www-form-urlencoded':
            data = urllib.parse.urlencode(body or {}).encode()
        try:
            connection.request(method, '/api' + path, data, supplied)
            response = connection.getresponse()
            status, response_headers, data = response.status, dict(response.getheaders()), response.read()
            cookie = response.getheader('Set-Cookie')
            if cookie:
                self.cookie = cookie.split(';',1)[0]
            if data and response.getheader('Content-Type','').startswith('application/json'):
                data = json.loads(data)
                if 'csrf_token' in data: self.csrf = data['csrf_token']
            return status, response_headers, data
        finally:
            connection.close()

    def api(self, path, method='GET', body=None):
        status, _, data = self.request(path, method, body)
        if status not in (200,201,202,204):
            payload=json.dumps(data).encode() if isinstance(data,dict) else data
            raise urllib.error.HTTPError(self.origin+'/api'+path,status,'API error',{},io.BytesIO(payload))
        return data

    def setup(self):
        return self.api('/setup','POST',dict(username='fixture',display_name='Fixture Administrator',password=PASSWORD))

    def login(self, username='fixture', password=PASSWORD):
        return self.api('/login','POST',dict(username=username,password=password))

    def connect(self, sid):
        status, headers, body = self.request('/sessions/'+sid+'/connect','POST',
            {'csrf_token':self.csrf},{'Content-Type':'application/x-www-form-urlencoded'})
        assert status == 303, (status,body)
        return headers['location'] if 'location' in headers else headers['Location']
