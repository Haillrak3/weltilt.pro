# OrderDesk API v1

Base URL: `https://weltilt.pro/desk-api/v1`

Роуты под `/desk-api/v1/` **зафиксированы** — не изменятся.  
Новые ломающие изменения будут выходить под `/desk-api/v2/`.

Список всех эндпоинтов: `GET /desk-api/v1/`

---

## Заказы

### GET `/orders`
Список заказов. Все параметры опциональны.

| Параметр | Тип | Описание |
|---|---|---|
| `phone` | string | Фильтр по телефону клиента |
| `status` | string | `created` / `in_progress` / `done` |
| `operator` | string | Фильтр по имени оператора |
| `store_id` | string | Фильтр по магазину |
| `date_from` | string | ISO 8601, включительно |
| `date_to` | string | ISO 8601, включительно |
| `offset` | number | Пагинация, по умолчанию 0 |
| `limit` | number | Пагинация, по умолчанию все |

**Ответ:**
```json
{
  "ok": true,
  "data": { "data": [...], "total": 42, "offset": 0, "limit": 20 }
}
```

### GET `/orders/:id`
Один заказ по ID.

### POST `/orders`
Создать заказ.

**Тело:**
```json
{
  "client": {
    "phone": "79991234567",
    "name": "Иван",
    "street": "Ленина",
    "house": "1",
    "entrance": "",
    "floor": "",
    "apartment": "",
    "intercom": "",
    "notes": ""
  },
  "items": [
    { "name": "Пиво Светлое", "qty": 2, "price": 150, "productType": "DRAFT" }
  ],
  "storeId": "13",
  "orderMethod": "phone",
  "payMethod": "cash",
  "operator": "Анна",
  "status": "created",
  "deliveryPrice": 300
}
```

`productType`: `DRAFT` / `BOTTLED` / `PIECE` / `WEIGHT`

**Ответ:** `201` + созданный заказ.

### PATCH `/orders/:id`
Обновить поля заказа. Передавать только изменяемые поля.

```json
{ "status": "done", "payMethod": "card" }
```

Допустимые поля: `status`, `storeId`, `client`, `payMethod`, `operator`, `orderMethod`, `orderNumber`, `deliveryPrice`, `orderAmount`, `items`, `given`, `change`.

### DELETE `/orders/:id`
Удалить заказ. Ответ: `{ "ok": true, "data": { "deleted": 1 } }`

---

## Клиенты

### GET `/clients`
Список / поиск клиентов.

| Параметр | Описание |
|---|---|
| `phone` | Поиск по части номера (мин. 3 цифры), возвращает до 20 |
| `search` | Поиск по имени или номеру, возвращает до 20 |
| `offset` / `limit` | Пагинация полного списка |

### GET `/clients/:phone`
Клиент по точному номеру телефона.

### POST `/clients`
Создать или обновить клиента (upsert по `phone`).

```json
{
  "phone": "79991234567",
  "name": "Иван Петров",
  "street": "Ленина",
  "house": "5",
  "apartment": "12",
  "notes": "Домофон не работает"
}
```

### PATCH `/clients/:phone`
Обновить отдельные поля клиента.

### DELETE `/clients/:phone`
Удалить клиента из базы.

---

## Свои товары

### GET `/local-products`
Список всех локальных товаров.

```json
[
  { "id": "local_1234", "name": "Доставка", "price": 300, "productType": "PIECE" }
]
```

### POST `/local-products`
Добавить товар.

```json
{ "name": "Пакет", "price": 10, "productType": "PIECE" }
```

`productType`: `PIECE` / `WEIGHT` / `DRAFT` / `BOTTLED`

### PATCH `/local-products/:id`
Обновить товар. Передавать только изменяемые поля: `name`, `price`, `productType`.

### DELETE `/local-products/:id`
Удалить товар.

---

## Формат ответов

Все ответы:
```json
{ "ok": true, "data": <payload> }
```

Ошибки:
```json
{ "ok": false, "error": "описание ошибки" }
```

HTTP-коды: `200` OK, `201` Created, `400` Bad Request, `404` Not Found, `500` Server Error.

---

## Статусы заказа

| Значение | Описание |
|---|---|
| `created` | Создан |
| `in_progress` | В работе |
| `done` | Выполнен |
