import { extractArray } from '../utils/helpers';
import { isExpenseActivity, resolveActivityPlayer } from '../components/Activity/activityUtils';
import { ACTIVITY_TYPES } from './balanceService';

const debuggedActivityIds = new Set();

// Primer valor definido de una lista de campos candidatos.
const pick = (item, keys) => {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return null;
};

// Ajusta estas listas a los campos reales de tu API.
const AMOUNT_KEYS = ['amount', 'price', 'money', 'value', 'cash'];
const DATE_KEYS = ['date', 'createdAt', 'timestamp', 'activityDate'];

// Nombre de un manager a partir de su id (managersCache: managerId -> manager).
const getManagerNameById = (managersCache, id) =>
  id != null ? managersCache?.get(String(id))?.managerName ?? null : null;

// Convierte un item de la API en una fila plana para diagnóstico.
export const summarizeActivity = (item, { managersCache, playersCache } = {}) => {
  const type = item.activityTypeId;
  const amount = Number(pick(item, AMOUNT_KEYS)) || 0;
  const { name: playerName } = resolveActivityPlayer(item, playersCache);

  return {
    managerName: getManagerNameById(managersCache, item.user1Id),
    activityId: item.id ?? null,
    activityTypeId: type ?? null,
    activityDescription: ACTIVITY_TYPES[type] ?? `Actividad tipo ${type}`,
    playerName,
    cashMoved: isExpenseActivity(type) ? -amount : amount, // negativo = gasto
    toManager: getManagerNameById(managersCache, item.user2Id) ?? 'market',
    dateOfTransaction: pick(item, DATE_KEYS),
  };
};

export const debugAllActivity = (activityData, options = {}) => {
  const rows = [];

  extractArray(activityData).forEach((item) => {
    if (debuggedActivityIds.has(item.id)) return;
    debuggedActivityIds.add(item.id);

    rows.push(summarizeActivity(item, options));
  });

  if (rows.length > 0) {
    // eslint-disable-next-line no-console
    console.log('ACTIVITY DEBUG\n' + JSON.stringify(rows, null, 2));
  }
  // eslint-disable-next-line no-console
  console.log('TOTAL UNIQUE DEBUGGED ACTIVITIES:', debuggedActivityIds.size);
};

export const resetActivityDebug = () => debuggedActivityIds.clear();