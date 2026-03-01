# Деплой License Server для Steam Route Tool

## Что нужно

- VPS (любой Linux) — подойдёт самый дешёвый за $3-5/мес (Hetzner, DigitalOcean, Timeweb, Aéza)
- Домен (опционально, но рекомендуется для HTTPS)

## Шаг 1: Подготовка VPS

Подключись по SSH и установи Node.js:

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs build-essential

# Проверь
node -v   # должно быть v20+
npm -v
```

## Шаг 2: Загрузка сервера

```bash
# Создай папку
mkdir -p /opt/srt-server
cd /opt/srt-server

# Скопируй файлы из папки server/ на VPS (через scp, sftp, или git)
# Пример через scp с твоего компа:
# scp -r ./server/* user@your-vps-ip:/opt/srt-server/
```

## Шаг 3: Установка зависимостей

```bash
cd /opt/srt-server
npm install
```

## Шаг 4: Настройка

Создай файл `.env` или задай переменные:

```bash
# Секретный ключ для сессий (замени на свой)
export ADMIN_SECRET="your-random-secret-string-here"
export PORT=3000
```

## Шаг 5: Первый запуск

```bash
node server.js
```

Увидишь:
```
Default admin created — login: admin / password: admin
License server running on http://localhost:3000
Admin panel: http://localhost:3000/admin
```

Зайди на `http://your-vps-ip:3000/admin`, залогинься admin/admin и СРАЗУ смени пароль.

## Шаг 6: Автозапуск через PM2

```bash
# Установи PM2
npm install -g pm2

# Запусти сервер
ADMIN_SECRET="your-secret" pm2 start server.js --name srt-license

# Автозапуск при перезагрузке VPS
pm2 startup
pm2 save
```

## Шаг 7: HTTPS через Nginx + Let's Encrypt

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Создай конфиг Nginx:

```bash
sudo nano /etc/nginx/sites-available/srt
```

Вставь (замени `srt.yourdomain.com` на свой домен):

```nginx
server {
    listen 80;
    server_name srt.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Активируй:

```bash
sudo ln -s /etc/nginx/sites-available/srt /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Получи SSL сертификат:

```bash
sudo certbot --nginx -d srt.yourdomain.com
```

## Шаг 8: Обнови URL в приложении

В файле `LicenseManager.cs` замени:

```csharp
private const string LicenseServerUrl = "https://srt.yourdomain.com/api/validate";
```

Пересобери приложение.

## Как пользоваться

1. Заходишь на `https://srt.yourdomain.com/admin`
2. Создаёшь лицензию — указываешь email клиента, план, срок
3. Получаешь ключ вида `SRT-A1B2C3-D4E5F6-789ABC-DEF012`
4. Отправляешь ключ клиенту
5. Клиент вводит email + ключ в приложении — активация привязывается к его машине
6. Если клиент сменил ПК — жмёшь "Reset HWID" в админке

## Безопасность

- Смени пароль admin сразу после первого входа
- Используй сложный `ADMIN_SECRET`
- Всегда используй HTTPS
- Бэкапь файл `data/licenses.db` — это вся база
