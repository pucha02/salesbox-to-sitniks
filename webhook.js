import express from 'express';

const app = express();
const PORT = process.env.PORT || 5001;

app.use(express.json());

app.post('/webhook/sync', (req, res) => {
  try {
    const { action, data } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Missing "action" field in request body.' });
    }

    console.log(`without action ${data}`);

    switch (action) {
      case 'NEW_ORDER':
        console.log('new', data);
        break;

      case 'UPDATE_ORDER':
        console.log('update', data);
        break;

      case 'NEW_ORDER_ID':
        console.log('new ID', data);
        break;

      case 'UPDATE_ORDER_ID':
        console.log('update ID', data);
        break;

      default:
        console.warn('Unhandled webhook action:', action);
        break;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});