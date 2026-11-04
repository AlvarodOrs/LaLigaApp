const INITIAL_BALANCE = 100_000_000;
const DAILY_BONUS = 100_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Ajustes para cuadrar con el saldo real del juego.
// Prueba true/false hasta que el resultado coincida.
const BONUS_INCLUDES_FIRST_DAY = false;

// En actividades tipo 1 (compra/clausulazo entre mánagers):
// true  -> user1 es el comprador (paga) y user2 el vendedor (cobra)
// false -> user1 es el vendedor y user2 el comprador
const TYPE1_USER1_IS_BUYER = true;

const ACTIVITY_TYPES = {
  1: 'Compra entre mánagers',
  4: 'Actividad tipo 4',
  6: 'Recompensa de jornada',
  7: 'Actividad tipo 7',
  9: 'Actividad tipo 9',
  31: 'Compra al mercado',
  33: 'Venta al mercado'
};

const getActivityDate = (activity) =>
  activity.createdAt || activity.timestamp || activity.date || null;

/**
 * Calcula los días transcurridos desde la fecha de inicio.
 * Cuenta días naturales; el primer día solo suma si BONUS_INCLUDES_FIRST_DAY.
 */
const getDaysElapsed = (startDate, now = new Date()) => {
  const start = new Date(startDate);

  if (Number.isNaN(start.getTime())) return 0;

  const startDay = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate()
  );

  const currentDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  const days = Math.round((currentDay - startDay) / DAY_MS);

  return Math.max(0, days + (BONUS_INCLUDES_FIRST_DAY ? 1 : 0));
};

/**
 * Obtiene la fecha de la actividad más antigua.
 */
const getFirstActivityDate = (activities) => {
  let oldest = null;

  for (const activity of activities) {
    const date = getActivityDate(activity);

    if (!date) continue;

    const timestamp = new Date(date).getTime();

    if (Number.isNaN(timestamp)) continue;

    if (!oldest || timestamp < oldest.timestamp) {
      oldest = { timestamp, date };
    }
  }

  return oldest?.date || null;
};

/**
 * Reconstruye el saldo y genera un historial auditable
 * de todas las actividades de cada mánager.
 *
 * Fórmula: 100M - compras + ventas + recompensas + 100.000 × días
 *
 * @param leagueStartDate Fecha real de creación de la liga (recomendado).
 *   Si no se pasa, se usa la actividad más antigua descargada.
 */
export const calculateManagerBalances = ({
  activities = [],
  managers = [],
  leagueStartDate = null,
  now = new Date()
}) => {
  // 1. Eliminar actividades duplicadas
  const seen = new Set();

  const uniqueActivities = activities.filter((activity) => {
    if (activity.id == null) return true;

    const id = String(activity.id);

    if (seen.has(id)) return false;

    seen.add(id);
    return true;
  });

  // 2. Fecha de inicio y bonificación diaria
  const firstActivityDate = getFirstActivityDate(uniqueActivities);
  const startDate = leagueStartDate || firstActivityDate;

  const daysElapsed = startDate ? getDaysElapsed(startDate, now) : 0;
  const dailyBonusTotal = daysElapsed * DAILY_BONUS;

  // 3. Inicializar mánagers
  const balances = {};

  for (const manager of managers) {
    if (manager.managerId == null) continue;

    const managerId = String(manager.managerId);

    balances[managerId] = {
      managerId,
      managerName: manager.managerName || 'Desconocido',
      teamId: manager.teamId,

      initialBalance: INITIAL_BALANCE,
      dailyBonus: dailyBonusTotal,

      balance: INITIAL_BALANCE + dailyBonusTotal,

      purchases: 0,
      sales: 0,
      matchdayRewards: 0,

      transactions: 0,
      ignoredTransactions: 0,

      history: []
    };
  }

  // 4. Procesar actividades
  const unmatchedActivities = [];
  const activityTypeSummary = {};

  for (const activity of uniqueActivities) {
    const type = Number(activity.activityTypeId);
    const amount = Number(activity.amount) || 0;

    const user1 = activity.user1Id != null ? String(activity.user1Id) : '';
    const user2 = activity.user2Id != null ? String(activity.user2Id) : '';

    const typeName = ACTIVITY_TYPES[type] || 'Tipo desconocido';
    const date = getActivityDate(activity);

    activityTypeSummary[type] = (activityTypeSummary[type] || 0) + 1;

    const affectedManagers = [];

    if (type === 1) {
      // Compra entre mánagers: uno paga y otro cobra
      const buyerId = TYPE1_USER1_IS_BUYER ? user1 : user2;
      const sellerId = TYPE1_USER1_IS_BUYER ? user2 : user1;

      if (balances[buyerId]) {
        affectedManagers.push({
          managerId: buyerId,
          direction: 'out',
          counterpartId: sellerId || null
        });
      }

      if (balances[sellerId]) {
        affectedManagers.push({
          managerId: sellerId,
          direction: 'in',
          counterpartId: buyerId || null
        });
      }
    } else if (balances[user1]) {
      affectedManagers.push({
        managerId: user1,
        direction:
          type === 31 ? 'out' :
          type === 33 || type === 6 ? 'in' : 'none',
        counterpartId: user2 || null
      });
    }

    if (affectedManagers.length === 0) {
      unmatchedActivities.push({
        id: activity.id,
        type,
        typeName,
        amount,
        user1Id: user1 || null,
        user2Id: user2 || null,
        date,
        raw: activity
      });

      continue;
    }

    // 5. Registrar la operación en cada mánager implicado
    for (const affected of affectedManagers) {
      const manager = balances[affected.managerId];

      let signedAmount = 0;
      let description = 'Sin movimiento económico';

      if (type === 1) {
        if (affected.direction === 'out') {
          signedAmount = -amount;
          description = 'Compra a otro mánager';
          manager.purchases += amount;
        } else {
          signedAmount = amount;
          description = 'Venta a otro mánager';
          manager.sales += amount;
        }
      } else if (type === 31) {
        signedAmount = -amount;
        description = 'Compra al mercado';
        manager.purchases += amount;
      } else if (type === 33) {
        signedAmount = amount;
        description = 'Venta al mercado';
        manager.sales += amount;
      } else if (type === 6) {
        signedAmount = amount;
        description = 'Recompensa de jornada';
        manager.matchdayRewards += amount;
      }

      const affectsBalance = signedAmount !== 0;

      if (affectsBalance) {
        manager.transactions++;
      } else {
        manager.ignoredTransactions++;
      }

      manager.history.push({
        id: activity.id ?? null,
        date,

        type,
        typeName,
        description,

        amount,
        signedAmount,

        direction: affected.direction,
        counterpartId: affected.counterpartId,

        affectsBalance,
        balanceAfter: 0, // se calcula en el paso 6

        raw: activity
      });
    }
  }

  // 6. Ordenar cronológicamente y calcular saldo acumulado.
  // Es la única fuente del saldo final (la bonificación va primero).
  for (const manager of Object.values(balances)) {
    manager.history.sort((a, b) => {
      const dateA = new Date(a.date || 0).getTime();
      const dateB = new Date(b.date || 0).getTime();

      return dateA - dateB;
    });

    let runningBalance = INITIAL_BALANCE + dailyBonusTotal;

    for (const transaction of manager.history) {
      runningBalance += transaction.signedAmount;
      transaction.balanceAfter = runningBalance;
    }

    manager.balance = runningBalance;
  }

  return {
    metadata: {
      firstActivityDate: startDate,
      daysElapsed,
      dailyBonusTotal,

      totalActivitiesReceived: activities.length,
      activitiesProcessed: uniqueActivities.length,
      duplicatedActivities: activities.length - uniqueActivities.length,

      managersProcessed: Object.keys(balances).length,

      activityTypeSummary,
      unmatchedActivities
    },

    balances
  };
};