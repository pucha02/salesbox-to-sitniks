// server.js
import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

// ========== Конфигурация ==========
const SALESBOX_API_URL = 'https://prod.salesbox.me/openapi/orders/all?page=1';
const SALESBOX_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyVHlwZSI6IkFETUlOIiwidHlwZSI6IlBFUlNPTkFMX0FDQ0VTU19UT0tFTiIsIl92IjoxLCJjb21wYW55SWQiOiJzYW5hIiwiaWF0IjoxNjkxMTUzMzM2fQ.KRvTjTk-qVH98zXxLzklw6nhbOzgZR4Fs0-D5ljakS0';

const SITNIKS_API_URL = 'https://crm.sitniks.com/open-api/orders';
const SITNIKS_TOKEN = 'Dioyg6qqdMhyx5iQz6BU24ZBz83HAIdPIEJ5X51YEvw';

// Клиенты Axios
const salesboxClient = axios.create({
    baseURL: SALESBOX_API_URL,
    headers: {
        'Authorization': `Bearer ${SALESBOX_TOKEN}`,
        'Content-Type': 'application/json',
    },
});

const sitniksClient = axios.create({
    baseURL: SITNIKS_API_URL,
    headers: {
        'Authorization': `Bearer ${SITNIKS_TOKEN}`,
        'Content-Type': 'application/json',
    },
});

// ========== Хелперы ==========

/**
 * Получить одну страницу заказов из SalesBox.
 */
async function fetchSalesboxOrders(page = 1, pageSize = 50) {
    const resp = await salesboxClient.get('', {
        params: { lang: 'uk', page, pageSize }
    });
    return resp.data.data || [];
}

/**
 * Проверить, существует ли заказ в Sitniks по externalId.
 */
async function sitniksOrderExists(externalId) {
    const resp = await sitniksClient.get('', { params: { externalId } });
    return Array.isArray(resp.data) && resp.data.length > 0;
}

/**
 * Функция для удаления эмодзи и спецсимволов (при необходимости)
 */
function removeSpecialCharacters(text) {
    // Убираем эмодзи и специальные символы, оставляем буквы, цифры, пробелы и дефисы
    return text.replace(/[\u{1F600}-\u{1F6FF}]/gu, '').replace(/[^\w\sа-яёіїєґ\-]/gi, '');
}

/**
 * Получить вариации товаров из Sitniks и создать карту сопоставлений.
 * Ключом будет нормализованное название товара, а значением – id вариации.
 * Приоритет отдаётся product.titleLang.uk, если он заполнен.
 */
async function fetchSitniksProductVariationMap() {
    try {
      const resp = await axios.get('https://crm.sitniks.com/open-api/products/variations', {
        headers: {
          'Authorization': `Bearer ${SITNIKS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
  
      const variations = resp.data.data || [];
  
      // Карта: sku (в нижнем регистре) → variationId
      return variations.reduce((map, variation) => {
        const sku = variation.sku?.trim().toLowerCase();
        if (sku) {
          map[sku] = variation.id;
        }
        return map;
      }, {});
    } catch (err) {
      console.error('Ошибка получения вариаций товаров из Sitniks:', err.response?.data || err.message);
      return {};
    }
  }

/**
 * Получить айди интеграции Nova Poshta из Sitniks
 * Обращаемся к endpoint: /open-api/integrations/nova-poshta/api-keys
 */
async function fetchNovaPoshtaIntegrationId() {
    try {
        const resp = await axios.get('https://crm.sitniks.com/open-api/integrations/nova-poshta/api-keys', {
            headers: {
                'Authorization': `Bearer ${SITNIKS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log('Ответ от Nova Poshta:', resp.data);
        // Предполагается, что resp.data.data является массивом интеграционных записей
        const keys = resp.data.data;
        if (Array.isArray(keys) && keys.length > 0) {
            return keys[0].id;
        }
        return null;
    } catch (err) {
        console.error('Ошибка получения id интеграции Nova Poshta:', err.response?.data || err.message);
        return null;
    }
}

/**
 * Преобразовать заказ из SalesBox в формат Sitniks.
 * Использует sitniksVariationMap для сопоставления товаров по названию.
 * Если передан novaPoshtaIntegrationId, включает npDelivery.
 */
function mapOrderToSitniks(sb, sitniksVariationMap, novaPoshtaIntegrationId, settlementAccountId) {
    function calculateProductEffectivePrice(product) {
      const basePrice = Number(product.price || 0);
      const discountPercent = Number(product.percentageDiscount || 0);
      const discountAmount = Number(product.discount || 0);
      const quantity = Number(product.categories?.[0]?.count || 0) || 1;
  
      let modifierValue = 0;
      if (Array.isArray(product.modifiers)) {
        const selectedMod = product.modifiers.find(m => m.selected);
        if (selectedMod?.selected?.m) {
          modifierValue = Number(selectedMod.selected.m) || 0;
        }
      }
  
      const finalUnitPrice = basePrice - (basePrice * (discountPercent / 100)) - discountAmount + modifierValue;
      return quantity * (finalUnitPrice > 0 ? finalUnitPrice : 0);
    }
  
    const products = (sb.offers || []).map((o) => {
      const vendorCode = o.vendorCode?.trim().toLowerCase();
      const matchedVariationId = vendorCode ? sitniksVariationMap[vendorCode] : undefined;
      const quantity = Number(o.categories?.[0]?.count || 0) || 1;
  
      return {
        productVariationId: matchedVariationId || o.offerId,
        isUpsale: false,
        discountPercent: o.percentageDiscount || 0,
        discountAmount: o.discount || 0,
        price: Number(o.price || 0),
        costPrice: Number(o.costPrice || o.price || 0),
        quantity,
        title: o.name || '',
        notes: o.description,
        warehouseId: 4505,
      };
    });
  
    const bonusesUsed = Number(sb.bonusesUsed || 0);
    const totalPayment = (sb.offers || []).reduce((sum, o) => {
      return sum + calculateProductEffectivePrice(o);
    }, 0) - bonusesUsed;
  
    const safeTotal = totalPayment > 0 ? totalPayment : 0;
  
    const npDelivery = novaPoshtaIntegrationId
      ? {
          integrationNovaposhtaId: novaPoshtaIntegrationId,
          serviceType: 'DoorsDoors',
          payerType: 'Sender',
          cargoType: 'Parcel',
          paymentMethod: 'NonCash',
          productPaymentMethod: 'postpaid',
          price: 0,
          weight: 0.1,
          seatsAmount: 1,
          region: sb.addressName || '',
          city: sb.addressName || '',
          department: sb.addressName || '',
        }
      : null;
  
    return {
      externalId: sb.id,
      client: {
        fullname: sb.customerName || '',
        phone: sb.phone,
      },
      products,
      clientComment: sb.comment || '',
      managerComment: sb.UserComments?.comment || '',
      statusId: 24380,
      utm: sb.utm || {},
      ...(npDelivery ? { npDelivery } : {}),
      payment: {
        settlementAccountId,
        amount: safeTotal,
        description: 'Оплата заказа с учётом скидок, модификаторов и бонусов',
      },
    };
  }


async function fetchSettlementAccountId() {
    try {
        const resp = await axios.get('https://crm.sitniks.com/open-api/settlement-accounts', {
            headers: {
                'Authorization': `Bearer ${SITNIKS_TOKEN}`,
                'Content-Type': 'application/json',
            },
        });

        const accounts = resp.data.data || [];

        // Здесь можно настроить критерий отбора — например, ищем первый счёт типа payment_system
        const targetAccount = accounts.find(a => a.type === 'payment_system');
        console.log('settlementAccountId settlementAccountIdsettlementAccountId:', accounts);

        return accounts[0].id;
    } catch (err) {
        console.error('Ошибка получения settlementAccountId:', err.response?.data || err.message);
        return null;
    }
}

/**
 * Создать заказ в Sitniks.
 */
async function createSitniksOrder(body) {
    const resp = await sitniksClient.post('', body);
    return resp.data;
}
async function fetchSalesboxOrdersFromLastPage(pageSize = 50) {
    let currentPage = 1;
    let lastNonEmptyOrders = [];

    while (true) {
        // Используем уже реализованную функцию для получения заказов с нужной страницы
        const currentOrders = await fetchSalesboxOrders(currentPage, pageSize);
        if (currentOrders.length === 0) {
            // Текущая страница пуста – значит, заказы с предыдущей страницы являются последними
            break;
        }
        // Сохраняем текущий набор заказов, предполагая, что он не пустой
        lastNonEmptyOrders = currentOrders;
        currentPage++;
    }

    return lastNonEmptyOrders;
}

// Пример маршрута для теста получения заказов с последней страницы
app.get('/last-page-orders', async (req, res) => {
    try {
        // pageSize можно задать через параметры запроса или оставить значение по умолчанию
        const pageSize = parseInt(req.query.pageSize, 10) || 50;
        const orders = await fetchSalesboxOrdersFromLastPage(pageSize);
        res.json({ success: true, pageSize, orders });
    } catch (err) {
        console.error('Ошибка получения заказов с последней страницы:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.response?.data || err.message });
    }
});
// ========== Маршрут для тестового перелива ==========
app.get('/test-transfer', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 5;

        const sitniksVariationMap = await fetchSitniksProductVariationMap();
        const novaPoshtaIntegrationId = await fetchNovaPoshtaIntegrationId(); // Предположим, ты уже добавил эту функцию
        const settlementAccountId = await fetchSettlementAccountId();

        const orders = await fetchSalesboxOrders(1, limit);
        const report = [];

        for (const sb of orders.slice(0, limit)) {
            try {
                const exists = await sitniksOrderExists(sb.id);
                if (exists) {
                    report.push({ orderNumber: sb.orderNumber, status: 'skipped' });
                    continue;
                }

                const body = mapOrderToSitniks(sb, sitniksVariationMap, novaPoshtaIntegrationId, settlementAccountId);
                console.log('Payload для создания заказа в Sitniks:', body);
                const created = await createSitniksOrder(body);
                report.push({
                    orderNumber: sb.orderNumber,
                    status: 'created',
                    sitniksId: created.id
                });
            } catch (err) {
                console.error(`Ошибка заказа ${sb.orderNumber}:`, err.response?.data || err.message);
                report.push({
                    orderNumber: sb.orderNumber,
                    status: 'error',
                    error: err.response?.data || err.message
                });
            }
        }

        res.json({ success: true, processed: report.length, report });
    } catch (err) {
        console.error('Ошибка тестового перелива:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.response?.data || err.message });
    }
});


// ========== Маршрут для получения статусов ==========
app.get('/statuses', async (req, res) => {
    try {
        const resp = await axios.get('https://crm.sitniks.com/open-api/orders/statuses', {
            headers: {
                Authorization: `Bearer ${SITNIKS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        res.json({
            success: true,
            count: resp.data.length,
            statuses: resp.data
        });
    } catch (err) {
        console.error('Ошибка получения статусов:', err.response?.data || err.message);
        res.status(500).json({
            success: false,
            error: err.response?.data || err.message
        });
    }
});

// ========== Запуск сервера ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('→ GET /test-transfer?limit=3 для тестового перелива');
});
