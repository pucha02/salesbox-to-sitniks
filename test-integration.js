// server.js
import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

// ========== Конфигурация ==========
const SALESBOX_API_URL = 'https://prod.salesbox.me/openapi/orders/all?page=1';
const SALESBOX_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';

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
  
        const map = variations.reduce((map, variation) => {
            const sku = variation.sku?.trim().toLowerCase();
            if (sku) {
                map[sku] = variation.id;
            }
            return map;
        }, {});
  
        console.debug(`fetchSitniksProductVariationMap: Получено ${Object.keys(map).length} вариаций`);
        return map;
    } catch (err) {
        console.error('Ошибка получения вариаций товаров из Sitniks:', err.response?.data || err.message);
        return {};
    }
}

/**
 * Получить productVariationId напрямую по sku через query-параметр.
 * Выполняется GET-запрос к API Sitniks по адресу:
 * https://crm.sitniks.com/open-api/products/variations?sku=<sku>
 *
 * @param {string} sku - Значение sku для поиска.
 * @returns {Promise<number|null>} - Идентификатор вариации или null, если товар не найден или произошла ошибка.
 */
async function fetchProductVariationBySku(sku) {
    const skuNormalized = sku.trim();
    console.debug(`fetchProductVariationBySku: Начало поиска для sku: "${skuNormalized}"`);
    try {
        const url = `https://crm.sitniks.com/open-api/products/variations?sku=${encodeURIComponent(skuNormalized)}`;
        const resp = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${SITNIKS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.debug('fetchProductVariationBySku: Получены данные от Sitniks:', resp.data);
        const variations = resp.data.data || [];
        if (variations.length > 0) {
            console.debug(`fetchProductVariationBySku: Найден productVariationId: ${variations[0].id} для sku: "${skuNormalized}"`);
            return variations[0].id;
        } else {
            console.debug(`fetchProductVariationBySku: Вариация не найдена для sku: "${skuNormalized}"`);
            return null;
        }
    } catch (err) {
        console.error('fetchProductVariationBySku: Ошибка получения товара по sku:', err.response?.data || err.message);
        return null;
    }
}

/**
 * Получить productVariationId по совпадению externalId.
 * (Сейчас напрямую через fetchProductVariationBySku)
 */
async function getProductVariationIdByExternalId(externalId) {
    console.debug(`getProductVariationIdByExternalId: Поиск для externalId: "${externalId}" через fetchProductVariationBySku`);
    return await fetchProductVariationBySku(externalId);
}

/**
 * // === NEW ===
 * Загрузить ВСЕ вариации товаров из Sitniks (постранично).
 * Учтите, что если товаров очень много, это может быть долго и «тяжело».
 * @returns {Promise<Array>} Массив объектов вариаций.
 */
async function fetchAllProductVariations() {
    let allVariations = [];
    let page = 1;
    const pageSize = 100; // или нужное вам число

    while (true) {
        try {
            const resp = await axios.get('https://crm.sitniks.com/open-api/products/variations', {
                headers: {
                    'Authorization': `Bearer ${SITNIKS_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    limit: pageSize,
                    skip: (page - 1) * pageSize
                }
            });
            const data = resp.data.data || [];
            if (data.length === 0) {
                break; // больше ничего не пришло
            }
            allVariations = allVariations.concat(data);
            
            // Если вернулась порция меньше pageSize — значит, достигли конца
            if (data.length < pageSize) {
                break;
            }
            page++;
        } catch (err) {
            console.error('fetchAllProductVariations: ошибка при загрузке вариаций:', err.response?.data || err.message);
            break;
        }
    }

    console.debug(`fetchAllProductVariations: Загружено вариаций: ${allVariations.length}`);
    return allVariations;
}

/**
 * // === NEW ===
 * Попытаться найти variationId по названию среди массива вариаций.
 * Можно настроить поиск:
 * - Точное совпадение .toLowerCase() === title.toLowerCase()
 * - Частичное include
 * - и т.д.
 */
function findVariationIdByName(variations, title) {
    const lowerTitle = title.trim().toLowerCase();
    // Пример точного совпадения
    const found = variations.find(v => (v.name || '').trim().toLowerCase() === lowerTitle);
    return found?.id || null;
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
 */
async function mapOrderToSitniks(sb, sitniksVariationMap, novaPoshtaIntegrationId, settlementAccountId) {
    function calculateProductEffectivePrice(product) {
        const basePrice = Number(product.price || 0);
        const discountPercent = Number(product.percentageDiscount || 0);
        const discountAmount = Number(product.discount || 0);
        const quantity = Number(product.categories?.[0]?.count || 1);

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

    // // === NEW === Загружаем все вариации заранее, чтобы не делать это в цикле слишком много раз.
    // Если у вас мало товаров, такой подход ок. Если много — возможно, стоит кэшировать.
    const allVariations = await fetchAllProductVariations();

    // Асинхронно обрабатываем товары заказа
    const products = await Promise.all((sb.offers || []).map(async (o) => {
        const vendorCode = o.externalId?.trim().toLowerCase();
        let matchedVariationId = null;

        // 1) Пытаемся найти по sku/вендорному коду через локальный map:
        if (vendorCode) {
            matchedVariationId = sitniksVariationMap[vendorCode];
        }

        // 2) Если не нашли в map, пробуем напрямую запросом:
        if (!matchedVariationId && vendorCode) {
            console.debug(`mapOrderToSitniks: Вариация не найдена в маппинге для vendorCode: "${vendorCode}". Пытаемся получить напрямую через запрос по sku.`);
            matchedVariationId = await fetchProductVariationBySku(vendorCode);
        }
        
        // === NEW ===
        // 3) Если всё ещё не нашли, то пытаемся искать по названию,
        //    но только если у нас есть какой-то title (o.name).
        const title = (o.name || o.vector || o.vectorName || '').trim() || 'Товар';
        if (!matchedVariationId && title) {
            console.debug(`mapOrderToSitniks: Не нашли по SKU. Пробуем искать по названию "${title}".`);
            matchedVariationId = findVariationIdByName(allVariations, title.toLowerCase());
        }

        if (!matchedVariationId) {
            // Если не найдено корректное значение, логируем предупреждение и исключаем товар
            console.error(`mapOrderToSitniks: Для товара с externalId "${o.externalId}" не найден productVariationId (ni по sku, ни по названию). Пропускаем товар.`);
            return null;
        }
        
        const quantity = Number(o.categories?.[0]?.count || 1);
    
        return {
            productVariationId: matchedVariationId,
            isUpsale: false,
            discountPercent: o.percentageDiscount || 0,
            discountAmount: o.discount || 0,
            price: Number(o.price || 0),
            costPrice: Number(o.costPrice || o.price || 0),
            quantity,
            title,
            notes: (o.description || '').trim(),
            warehouseId: 4224,
        };
    }));
    
    // Отфильтровать товары, для которых не найден productVariationId
    const validProducts = products.filter(p => p !== null);
    if (!validProducts.length) {
        throw new Error('Не найдены валидные товары для создания заказа');
    }

    const bonusesUsed = Number(sb.bonusesUsed || 0);
    const totalPayment = (sb.offers || []).reduce((sum, o) => {
        return sum + calculateProductEffectivePrice(o);
    }, 0) - bonusesUsed;

    const safeTotal = totalPayment > 0 ? totalPayment : 0;

    const npDelivery = 1822
        ? {
              integrationNovaposhtaId: 1822,
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
        products: validProducts,
        clientComment: sb.comment || '',
        managerComment: sb.UserComments?.comment || '',
        statusId: 17923,
        salesChannelId: 4814,
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
        const orderBody = await mapOrderToSitniks(
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

                const body = await mapOrderToSitniks(sb, sitniksVariationMap, novaPoshtaIntegrationId, settlementAccountId);
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
