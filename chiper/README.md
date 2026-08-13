# Chiper — структура проекта

Приложение разбито по папкам по функциональности.

```
chiper/
├── index.html              # Точка входа (SPA)
├── css/
│   └── main.css            # Все стили
├── js/
│   ├── app.js              # Инициализация
│   ├── core/               # Данные, тема, навигация, UI
│   │   ├── data.js
│   │   ├── theme.js
│   │   ├── nav.js
│   │   ├── ui.js
│   │   └── product-v4.js
│   ├── auth/               # Логин / регистрация / onboarding
│   │   └── auth.js
│   ├── chat/               # Чаты, сообщения, голос
│   │   └── chat.js
│   ├── calls/              # WebRTC звонки
│   │   └── calls-v1.js
│   ├── premium/            # Premium-подписка
│   │   └── premium-core.js
│   ├── coin/               # Chiper Coin, звёзды, бейджи
│   │   └── coins-admin.js
│   └── admin/              # Админ-панель
│       └── admin.js
├── login/                  # → см. js/auth/
├── registration/           # → см. js/auth/
├── coin/                   # → см. js/coin/
├── premium/                # → см. js/premium/
├── chat/
├── calls/
├── admin/
├── profile/
├── settings/
└── assets/                 # logo.jpg, search.svg (добавьте сами)
```

## Запуск

Откройте `index.html` через локальный сервер (Firebase Auth / Firestore требуют http(s), не `file://`):

```bash
npx serve .
# или
python -m http.server 8080
```

## Экраны (SPA)

Все экраны остаются в `index.html` и переключаются функцией `go('name')`:

login, register, onboarding, chats, chat, settings, profile, profile-edit,
storage, premium, customize, newchat, archive, gsearch, userinfo, admin

## Зависимости скриптов

Порядок загрузки важен (глобальные `state`, функции):

1. core/data → theme → nav → ui → product-v4  
2. auth  
3. chat  
4. calls  
5. premium  
6. coin/coins-admin  
7. app.js (init)
