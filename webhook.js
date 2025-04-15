import express from 'express';

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware для парсинга JSON в теле запроса
app.use(express.json());

/**
 * Эндпоинт для приёма вебхуков.
 * Ожидается, что в теле запроса придёт JSON следующей структуры:
 * {
 *   "action": "NEW_ORDER" | "UPDATE_ORDER" | "NEW_ORDER_ID" | "UPDATE_ORDER_ID",
 *   "data": { ... } // объект с данными заказа или просто ID
 * }
 */
app.post('/webhook/sync', (req, res) => {
  try {
    const { action, data } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Missing "action" field in request body.' });
    }

    console.log(`without case ${data}`);

    switch (action) {
      case 'NEW_ORDER':
        // Логика для обработки нового заказа
        console.log('new', data);
        // Например, можно вызвать функцию processNewOrder(data);
        break;

      case 'UPDATE_ORDER':
        // Логика для обработки обновления заказа
        console.log('update', data);
        // Например, можно вызвать функцию processUpdateOrder(data);
        break;

      case 'NEW_ORDER_ID':
        // Логика для обработки события получения ID нового заказа
        console.log('new ID', data);
        // Например, можно вызвать функцию processNewOrderById(data);
        break;

      case 'UPDATE_ORDER_ID':
        // Логика для обработки события получения ID обновлённого заказа
        console.log('update ID', data);
        // Например, можно вызвать функцию processUpdateOrderById(data);
        break;

      default:
        console.warn('Unhandled webhook action:', action);
        break;
    }

    // Отправляем ответ, что вебхук успешно обработан
    res.json({ success: true });
  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
