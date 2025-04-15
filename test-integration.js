// server.js
import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

// ========== Конфигурация ==========

const SALESBOX_API_URL = 'https://prod.salesbox.me/openapi/orders/all?page=1';
const SALESBOX_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyVHlwZSI6IkFETUlOIiwidHlwZSI6IlBFUlNPTkFMX0FDQ0VTU19UT0tFTiIsIl92IjoxLCJjb21wYW55SWQiOiJzYW5hIiwiaWF0IjoxNjkxMTUzMzM2fQ.KRvTjTk-qVH98zXxLzklw6nhbOzgZR4Fs0-D5ljakS0';

const SITNIKS_API_URL = 'https://crm.sitniks.com/open-api/orders';
const SITNIKS_TOKEN = 'G7R4Q6VfQZGrFRI6szEQFEkDxmSyA3i5jmqvRuCpfz1';

// ========= Клиенты Axios =========
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

// ========== Вспомогательные функции ==========

/**
 * Проверить, существует ли заказ в Sitniks по externalId.
 */
async function sitniksOrderExists(externalId) {
    const resp = await sitniksClient.get('', { params: { externalId } });
    return Array.isArray(resp.data) && resp.data.length > 0;
}

/**
 * Функция для получения маппинга вариаций товаров из Sitniks.
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
 * Получить id интеграции Nova Poshta из Sitniks.
 */
async function fetchNovaPoshtaIntegrationId() {
    try {
        const resp = await axios.get('https://crm.sitniks.com/open-api/integrations/nova-poshta/api-keys', {
            headers: {
                'Authorization': `Bearer ${SITNIKS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
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
 * Получить id расчётного счёта из Sitniks.
 */
async function fetchSettlementAccountId() {
    try {
        const resp = await axios.get('https://crm.sitniks.com/open-api/settlement-accounts', {
            headers: {
                'Authorization': `Bearer ${SITNIKS_TOKEN}`,
                'Content-Type': 'application/json',
            },
        });
        const accounts = resp.data.data || [];
        const targetAccount = accounts.find(a => a.type === 'payment_system');
        return targetAccount ? targetAccount.id : accounts[0]?.id;
    } catch (err) {
        console.error('Ошибка получения settlementAccountId:', err.response?.data || err.message);
        return null;
    }
}

/**
 * Преобразовать заказ из SalesBox (или вебхука) в формат Sitniks.
 * Функция использует mаппинг вариаций и, при наличии, интеграцию Nova Poshta.
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
            warehouseId: 4224,
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
        statusId: 17923,
        utm: sb.utm || {},
        ...(npDelivery ? { npDelivery } : {}),
        payment: {
            settlementAccountId,
            amount: safeTotal,
            description: 'Оплата заказа с учётом скидок, модификаторов и бонусов',
        },
    };
}

/**
 * Создать заказ в Sitniks.
 */
async function createSitniksOrder(body) {
    const resp = await sitniksClient.post('', body);
    return resp.data;
}

// ========== Маршрут вебхука ==========

app.post('/webhook/sync', async (req, res) => {
    try {
        const webhookData = req.body;
        console.log('Получен вебхук:', webhookData);

        // Проверка: если заказ уже существует в Sitniks – пропускаем дальнейшее создание
        const exists = await sitniksOrderExists(webhookData.id);
        if (exists) {
            console.log(`Заказ с externalId ${webhookData.id} уже существует в Sitniks`);
            return res.json({ success: true, message: 'Заказ уже существует' });
        }

        // Получаем необходимые данные для маппинга заказа
        const sitniksVariationMap = await fetchSitniksProductVariationMap();
        const novaPoshtaIntegrationId = await fetchNovaPoshtaIntegrationId();
        const settlementAccountId = await fetchSettlementAccountId();

        // Преобразуем входящий заказ (формат SalesBox) в формат Sitniks
        const orderBody = mapOrderToSitniks(
            webhookData,
            sitniksVariationMap,
            novaPoshtaIntegrationId,
            settlementAccountId
        );
        console.log('Payload для создания заказа в Sitniks:', orderBody);

        // Создаем заказ в Sitniks
        const createdOrder = await createSitniksOrder(orderBody);
        console.log('Заказ создан в Sitniks:', createdOrder);

        return res.json({ success: true, order: createdOrder });
    } catch (err) {
        console.error('Ошибка при обработке вебхука:', err.response?.data || err.message);
        return res.status(500).json({ success: false, error: err.response?.data || err.message });
    }
});

// ========== Прочие маршруты, например, тестовый перелив ==========

app.get('/test-transfer', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 5;

        const sitniksVariationMap = await fetchSitniksProductVariationMap();
        const novaPoshtaIntegrationId = await fetchNovaPoshtaIntegrationId();
        const settlementAccountId = await fetchSettlementAccountId();

        // Пример: получение заказов из SalesBox (замените на реальную логику, если требуется)
        const ordersResponse = await salesboxClient.get('', { params: { lang: 'uk', page: 1, pageSize: limit } });
        const orders = ordersResponse.data.data || [];

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

// ========== Запуск сервера ==========
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('→ GET /test-transfer?limit=3 для тестового перелива');
});
