/**
 * Получить список складов из Sitniks.
 */
const SITNIKS_TOKEN = 'G7R4Q6VfQZGrFRI6szEQFEkDxmSyA3i5jmqvRuCpfz1';
import axios from 'axios';
async function fetchWarehouses() {
    try {
        const resp = await axios.get('https://crm.sitniks.com/open-api/sales-channels', {
            headers: {
                'Authorization': `Bearer ${SITNIKS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log('Список:', resp.data);
        // Предполагаем, что складские данные находятся в resp.data.data
        return resp.data.data;
    } catch (err) {
        console.error('Ошибка получения складов из Sitniks:', err.response?.data || err.message);
        return [];
    }
}
fetchWarehouses()