import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from '../../utils/motionShim';
import { useNavigate } from 'react-router-dom';
import { Trophy, Crown, ChevronUp, ChevronDown, ChevronsUpDown, RefreshCw } from 'lucide-react';
import { fantasyAPI } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { formatCurrency, formatNumber, extractArray, readTeamMoney } from '../../utils/helpers';
import LoadingSpinner from '../Common/LoadingSpinner';
import ErrorDisplay from '../Common/ErrorDisplay';
import useMarketTrends from '../../hooks/useMarketTrends';
import useTeamMarketIncreases from '../../hooks/useTeamMarketIncreases';
import { useCurrentWeek } from '../../hooks/useCurrentWeek';
import StandingsEvolution from './StandingsEvolution';
import { calculateManagerBalances } from '../../services/balanceService';
import { buildManagersCache, buildPlayersCache } from '../Activity/activityUtils';
import { debugAllActivity } from '../../services/activityService';

// teamMoney puede venir como número, texto numérico u objeto
const parseTeamMoney = (raw) => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;

  if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }

  if (raw && typeof raw === 'object') {
    for (const key of ['money', 'amount', 'value', 'balance', 'teamMoney']) {
      const parsed = parseTeamMoney(raw[key]);
      if (parsed !== null) return parsed;
    }
  }

  return null;
};

const Standings = () => {
  const leagueId = useAuthStore((state) => state.leagueId);
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [teamWeekPoints, setTeamWeekPoints] = useState(new Map());
  const [sortBy, setSortBy] = useState('position');
  const [sortOrder, setSortOrder] = useState('asc');

  // Obtener clasificación
  const { data: standings, isLoading, error, refetch } = useQuery({
    queryKey: ['standings', leagueId],
    queryFn: () => fantasyAPI.getLeagueRanking(leagueId),
    enabled: !!leagueId,
    retry: false,
    staleTime: 1 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  // Obtener historial de actividad para reconstruir los saldos
  const {
    data: balanceActivities = [],
    isLoading: isLoadingBalances,
    error: balanceError
  } = useQuery({
    queryKey: ['activityForBalances', leagueId],
    queryFn: async () => {
      const activities = [];
      const seenIds = new Set();
      const MAX_PAGES = 100; // solo como límite de seguridad

      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await fantasyAPI.getLeagueActivity(leagueId, page);
        const pageActivities = extractArray(response);

        // DEBUG
        // console.log('ACTIVITY SAMPLE:', pageActivities.slice(0, 5));

        if (pageActivities.length === 0) break;

        // Si la API repite la última página, cortamos el bucle
        const fresh = pageActivities.filter(
          (a) => a.id == null || !seenIds.has(String(a.id))
        );

        if (fresh.length === 0) break;

        fresh.forEach((a) => {
          if (a.id != null) seenIds.add(String(a.id));
        });

        activities.push(...fresh);

        await new Promise(resolve => setTimeout(resolve, 300));
      }

      return activities;
    },
    enabled: !!leagueId,
    retry: false,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  // Get current week to fetch week points
  const { weekNumber: currentWeekNumber } = useCurrentWeek();

  // Market trends
  const { trendsReady: trendsInitialized } = useMarketTrends();

  // Team market value increases
  const teamMarketIncreases = useTeamMarketIncreases(
    standings,
    leagueId,
    trendsInitialized
  );

  // Fetch week points from weekly ranking
  useEffect(() => {
    const fetchTeamWeekPoints = async () => {
      if (!leagueId || !currentWeekNumber) return;

      const currentWeek = currentWeekNumber;

      try {
        let weekToShow = currentWeek;

        try {
          const matchesResponse = await queryClient.fetchQuery({
            queryKey: ['matches', currentWeek],
            queryFn: () => fantasyAPI.getMatchday(currentWeek),
            staleTime: 2 * 60 * 1000,
            gcTime: 5 * 60 * 1000,
          });

          const matches = extractArray(matchesResponse);

          const hasAnyMatchStarted = matches.some(match =>
            typeof match.matchState === 'number' && match.matchState >= 2
          );

          if (!hasAnyMatchStarted && currentWeek > 1) {
            weekToShow = currentWeek - 1;
          }
        } catch (matchError) {
          // Si no se pueden consultar los partidos, se usa la jornada actual.
        }

        const weeklyRanking = await queryClient.fetchQuery({
          queryKey: ['weeklyRanking', leagueId, weekToShow],
          queryFn: () => fantasyAPI.getLeagueRankingByWeek(leagueId, weekToShow),
          staleTime: 2 * 60 * 1000,
          gcTime: 5 * 60 * 1000,
        });

        const weekPointsMap = new Map();
        const weeklyData = extractArray(weeklyRanking);

        weeklyData.forEach(item => {
          const teamId = item.team?.id;
          const weekPoints = item.points || 0;

          if (teamId) {
            weekPointsMap.set(teamId, weekPoints);
          }
        });

        setTeamWeekPoints(weekPointsMap);

      } catch (error) {
        console.error('Error fetching team week points:', error);
      }
    };

    fetchTeamWeekPoints();
  }, [leagueId, currentWeekNumber, queryClient]);

  // Normalizar datos de clasificación
  const standingsData = useMemo(
    () => extractArray(standings),
    [standings]
  );

  // Helper functions
  const getTeamName = (item) => {
    return item.name || item.team?.name || 'Equipo';
  };

  const getManagerName = (item) => {
    return item.manager || item.team?.manager?.managerName || 'Manager';
  };

  const getManagerId = (item) => {
    return item.managerId ||
      item.team?.manager?.id ||
      item.userId ||
      item.team?.userId;
  };

  const getTeamPoints = (item) => {
    return item.points || item.team?.points || 0;
  };

  const getTeamValue = (item) => {
    return item.teamValue || item.team?.teamValue || 0;
  };

  const getTeamId = (item) => {
    return item.id || item.team?.id;
  };

  const getUserId = (item) => {
    return item.userId || item.team?.userId || item.team?.manager?.id;
  };

  const isCurrentUser = (item) => {
    const itemUserId = getUserId(item);

    return itemUserId &&
      user?.userId &&
      itemUserId.toString() === user.userId.toString();
  };

  const getTeamMarketIncrease = useCallback((item) => {
    const teamId = getTeamId(item);
    return teamMarketIncreases.get(teamId) || 0;
  }, [teamMarketIncreases]);

  const getWeekPoints = useCallback((item) => {
    const teamId = getTeamId(item);
    const weekPointsFromMap = teamWeekPoints.get(teamId);

    if (weekPointsFromMap !== undefined) {
      return weekPointsFromMap;
    }

    return item.weekPoints || item.team?.weekPoints || 0;
  }, [teamWeekPoints]);

  // Equipo del usuario actual (para pedir su saldo real)
  const ownTeamId = useMemo(() => {
    const own = standingsData.find(isCurrentUser);
    return own ? getTeamId(own) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standingsData, user?.userId]);

  // Saldo REAL del usuario: la API solo lo devuelve para el propio equipo
  const { data: ownMoneyRaw } = useQuery({
    queryKey: ['ownTeamMoney', ownTeamId],
    queryFn: () => fantasyAPI.getTeamMoney(ownTeamId),
    enabled: !!ownTeamId,
    retry: false,
    staleTime: 2 * 60 * 1000,
  });

  const ownMoney = ownMoneyRaw ? readTeamMoney(ownMoneyRaw) : null;

  // Saldo REAL de todos los equipos: getTeamData devuelve `teamMoney`.
  // Comparte la caché ['teamData', leagueId, teamId] con la pantalla de jugadores.
  const teamIdsKey = standingsData.map(getTeamId).filter(Boolean).join(',');

  const { data: teamMoneyMap = {}, isLoading: isLoadingTeamMoney } = useQuery({
    queryKey: ['teamMoneyAll', leagueId, teamIdsKey],
    queryFn: async () => {
      const result = {};

      for (const item of standingsData) {
        const teamId = getTeamId(item);
        if (!teamId) continue;

        try {
          const res = await queryClient.fetchQuery({
            queryKey: ['teamData', leagueId, teamId],
            queryFn: () => fantasyAPI.getTeamData(leagueId, teamId),
            staleTime: 3 * 60 * 1000,
          });

          const raw = res?.data?.teamMoney ?? res?.teamMoney;
          result[String(teamId)] = parseTeamMoney(raw);
        } catch (e) {
          result[String(teamId)] = null;
        }

        await new Promise(resolve => setTimeout(resolve, 300));
      }

      return result;
    },
    enabled: !!leagueId && standingsData.length > 0,
    retry: false,
    staleTime: 2 * 60 * 1000,
  });

  // Reconstruir los saldos estimados del resto de mánagers
  const managerBalancesData = useMemo(() => {
    const managers = standingsData
      .map(item => ({
        managerId: getManagerId(item),
        managerName: getManagerName(item),
        teamId: getTeamId(item)
      }))
      .filter(manager => manager.managerId != null);

    return calculateManagerBalances({
      activities: balanceActivities,
      managers
    });
  }, [standingsData, balanceActivities]);

  const managerBalances = managerBalancesData.balances || {};

  // Saldo de un equipo: real si es el tuyo, estimado para los demás
  const getRealBalance = (item) => {
    const fromTeamData = teamMoneyMap[String(getTeamId(item))];

    if (typeof fromTeamData === 'number') return fromTeamData;

    if (isCurrentUser(item) && typeof ownMoney === 'number') return ownMoney;

    return null;
  };

  const getEstimatedBalance = (item) => {
    const managerId = getManagerId(item);

    if (managerId == null) return null;

    return managerBalances[String(managerId)]?.balance ?? null;
  };

  const getManagerBalance = (item) => {
    const real = getRealBalance(item);

    if (real !== null) return real;

    return getEstimatedBalance(item);
  };

  const isRealBalance = (item) => getRealBalance(item) !== null;
  // Handle column header click for sorting
  const handleSort = (column) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder(column === 'position' ? 'asc' : 'desc');
    }
  };

  // Sort standings based on selected column and order
  const sortedStandings = useMemo(() => {
    const data = Array.isArray(standingsData) ? [...standingsData] : [];

    return data.sort((a, b) => {
      let valueA, valueB;

      switch (sortBy) {
        case 'position':
          valueA = a.position || 999;
          valueB = b.position || 999;
          break;

        case 'manager':
          valueA = getManagerName(a).toLowerCase();
          valueB = getManagerName(b).toLowerCase();
          break;

        case 'points':
          valueA = getTeamPoints(a);
          valueB = getTeamPoints(b);
          break;

        case 'weekPoints':
          valueA = getWeekPoints(a);
          valueB = getWeekPoints(b);
          break;

        case 'value':
          valueA = getTeamValue(a);
          valueB = getTeamValue(b);
          break;

        case 'balance':
          valueA = getManagerBalance(a) ?? -1;
          valueB = getManagerBalance(b) ?? -1;
          break;

        case 'marketIncrease':
          valueA = getTeamMarketIncrease(a);
          valueB = getTeamMarketIncrease(b);
          break;

        default:
          valueA = a.position || 999;
          valueB = b.position || 999;
      }

      if (typeof valueA === 'string' && typeof valueB === 'string') {
        return sortOrder === 'asc'
          ? valueA.localeCompare(valueB)
          : valueB.localeCompare(valueA);
      }

      return sortOrder === 'asc'
        ? valueA - valueB
        : valueB - valueA;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    standingsData,
    sortBy,
    sortOrder,
    getTeamMarketIncrease,
    getWeekPoints,
    managerBalances,
    ownMoney,
    teamMoneyMap,
    user?.userId
  ]);

  // Diagnóstico: volcar la actividad al entrar en Clasificación
  useEffect(() => {
    if (isLoadingBalances || balanceActivities.length === 0) return;

    debugAllActivity(balanceActivities, {
      managersCache: buildManagersCache(standings),
      playersCache: buildPlayersCache(queryClient.getQueryData(['allPlayers'])),
    });
  }, [balanceActivities, isLoadingBalances, standings, queryClient]);

  // Guarded UI returns after hooks
  if (isLoading) return <LoadingSpinner fullScreen={true} />;

  if (error) {
    return (
      <ErrorDisplay
        error={error}
        title="Error al cargar la clasificación"
        onRetry={refetch}
        fullScreen={true}
      />
    );
  }

  const getPositionBadge = (position) => {
    if (position === 1) {
      return <Crown className="w-5 h-5 text-yellow-500" />;
    } else if (position <= 3) {
      return <Trophy className="w-5 h-5 text-orange-500" />;
    }

    return null;
  };

  const formatMarketChange = (change) => {
    if (!change || change === 0) return '0€';

    const formattedValue = Math.abs(change).toLocaleString('es-ES');

    return change > 0
      ? `+${formattedValue}€`
      : `-${formattedValue}€`;
  };

  const handleRowClick = (item) => {
    const teamId = getTeamId(item);

    if (teamId) {
      navigate(`/teams/${teamId}/players`);
    }
  };

  // Helper component for sortable column headers
  const SortableHeader = ({ column, children, align = 'left' }) => {
    const isActive = sortBy === column;

    const alignClass = align === 'right'
      ? 'text-right'
      : align === 'center'
        ? 'text-center'
        : 'text-left';

    return (
      <th
        className={`px-6 py-4 ${alignClass} text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors select-none`}
        onClick={() => handleSort(column)}
      >
        <div className={`flex items-center gap-2 ${
          align === 'right'
            ? 'justify-end'
            : align === 'center'
              ? 'justify-center'
              : 'justify-start'
        }`}>
          <span>{children}</span>

          {isActive ? (
            sortOrder === 'asc'
              ? <ChevronUp className="w-4 h-4" />
              : <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronsUpDown className="w-4 h-4 opacity-40" />
          )}
        </div>
      </th>
    );
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Clasificación
          </h1>

          <p className="text-gray-500 dark:text-gray-400 mt-1">
            {sortedStandings.length} equipos en la liga
          </p>
        </div>

        <button
          onClick={async () => {
            await queryClient.invalidateQueries({
              queryKey: ['standings', leagueId]
            });

            await queryClient.invalidateQueries({
              queryKey: ['teamData']
            });

            await queryClient.invalidateQueries({
              queryKey: ['activityForBalances', leagueId]
            });

            await queryClient.invalidateQueries({
              queryKey: ['ownTeamMoney']
            });

            await queryClient.invalidateQueries({
              queryKey: ['teamMoneyAll']
            });

            refetch();
          }}
          className="btn-primary flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" aria-hidden="true" />
          Actualizar
        </button>
      </div>

      {/* Evolución de posiciones por jornada */}
      <StandingsEvolution
        leagueId={leagueId}
        currentWeekNumber={currentWeekNumber}
        userTeamId={getTeamId(standingsData.find(isCurrentUser) || {})}
      />

      {/* Información del cálculo de saldos */}
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {isLoadingTeamMoney
          ? 'Cargando saldos de todos los equipos...'
          : 'Saldos reales obtenidos de la plantilla de cada equipo. Si alguno no está disponible, se muestra una estimación.'}
      </div>

      {balanceError && (
        <div className="text-xs text-red-500">
          No se ha podido cargar el historial necesario para calcular los saldos.
        </div>
      )}

      {/* Standings Table - Desktop */}
      <div className="card overflow-hidden hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <SortableHeader column="position">Posición</SortableHeader>
                <SortableHeader column="manager">Manager</SortableHeader>
                <SortableHeader column="weekPoints" align="right">Pts Jornada</SortableHeader>
                <SortableHeader column="points" align="right">Puntos</SortableHeader>
                <SortableHeader column="marketIncrease" align="right">Subida Valor</SortableHeader>
                <SortableHeader column="value" align="right">Valor</SortableHeader>
                <SortableHeader column="balance" align="right">Saldo</SortableHeader>
              </tr>
            </thead>

            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedStandings.map((item, index) => {
                const position = item.position || index + 1;
                const isUser = isCurrentUser(item);
                const balance = getManagerBalance(item);
                const real = isRealBalance(item);
                const estimated = isUser && real ? getEstimatedBalance(item) : null;

                return (
                  <motion.tr
                    key={item.id || item.team?.id || index}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05 }}
                    onClick={() => handleRowClick(item)}
                    className={`hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer ${
                      isUser ? 'bg-primary-50 dark:bg-primary-900/20' : ''
                    }`}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {getPositionBadge(position)}

                        <span className={`text-lg font-bold ${
                          position <= 3
                            ? 'text-yellow-600 dark:text-yellow-400'
                            : 'text-gray-900 dark:text-white'
                        }`}>
                          {position}
                        </span>

                        {isUser && (
                          <span className="badge bg-primary-100 text-primary-800 dark:bg-primary-900/30 dark:text-primary-400">
                            Tú
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-gradient-to-br from-primary-400 to-primary-500 rounded-full flex items-center justify-center">
                          <span className="text-white text-sm font-bold">
                            {getManagerName(item).charAt(0)}
                          </span>
                        </div>

                        <div>
                          <div className="font-semibold text-gray-900 dark:text-white">
                            {getManagerName(item)}
                          </div>

                          <div className="text-sm text-gray-500 dark:text-gray-400">
                            {getTeamName(item)}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="text-lg font-bold text-primary-600 dark:text-primary-400">
                        {formatNumber(getWeekPoints(item))}
                      </div>

                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        jornada actual
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="text-lg font-bold text-gray-900 dark:text-white">
                        {formatNumber(getTeamPoints(item))}
                      </div>

                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        total
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className={`text-sm font-medium ${
                        getTeamMarketIncrease(item) > 0
                          ? 'text-green-600 dark:text-green-400'
                          : getTeamMarketIncrease(item) < 0
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-gray-600 dark:text-gray-400'
                      }`}>
                        {formatMarketChange(getTeamMarketIncrease(item))}
                      </div>

                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {trendsInitialized ? 'últimas 24h' : 'cargando...'}
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">
                        {formatCurrency(getTeamValue(item))}
                      </div>

                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        valor
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="text-sm font-bold text-green-600 dark:text-green-400">
                        {balance === null
                          ? (isLoadingTeamMoney || isLoadingBalances ? 'Calculando...' : 'No disponible')
                          : formatCurrency(balance)}
                      </div>

                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {real ? 'saldo real' : 'saldo estimado'}
                      </div>

                      {estimated !== null && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          estimado: {formatCurrency(estimated)}
                        </div>
                      )}
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Standings Cards - Mobile */}
      <div className="md:hidden space-y-3">
        {sortedStandings.map((item, index) => {
          const position = item.position || index + 1;
          const isUser = isCurrentUser(item);
          const balance = getManagerBalance(item);
          const real = isRealBalance(item);
          const estimated = isUser && real ? getEstimatedBalance(item) : null;

          return (
            <motion.div
              key={item.id || item.team?.id || index}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.02 }}
              onClick={() => handleRowClick(item)}
              className={`card p-5 cursor-pointer transition-all hover:shadow-lg ${
                isUser ? 'ring-2 ring-primary-500 bg-primary-50 dark:bg-primary-900/20' : ''
              }`}
            >
              <div className="flex flex-col gap-4">
                {/* Header: Position + Manager Info */}
                <div className="flex items-start gap-4">
                  <div className="flex flex-col items-center justify-center min-w-[60px] pt-1">
                    {getPositionBadge(position)}

                    <div className={`text-3xl font-black ${
                      position <= 3
                        ? 'text-yellow-600 dark:text-yellow-400'
                        : 'text-gray-900 dark:text-white'
                    }`}>
                      {position}
                    </div>

                    <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase mt-0.5">
                      Pos
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-12 h-12 bg-gradient-to-br from-primary-400 to-primary-500 rounded-full flex items-center justify-center flex-shrink-0 shadow-md">
                        <span className="text-white text-lg font-bold">
                          {getManagerName(item).charAt(0)}
                        </span>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-bold text-base text-gray-900 dark:text-white truncate">
                            {getManagerName(item)}
                          </div>

                          {isUser && (
                            <span className="badge bg-primary-500 text-white text-xs px-2 py-0.5">
                              Tú
                            </span>
                          )}
                        </div>

                        <div className="text-sm text-gray-600 dark:text-gray-400 truncate mt-0.5">
                          {getTeamName(item)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Stats */}
                <div
                  className="grid pt-3 border-t border-gray-200 dark:border-gray-700"
                  style={{
                    gridTemplateColumns: '1fr 1fr 1.5fr 1.5fr 1.5fr',
                    gap: '0.25rem'
                  }}
                >
                  <div className="text-center">
                    <div className="text-[9px] font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">
                      Jor
                    </div>

                    <div className="text-xs font-black text-primary-600 dark:text-primary-400 leading-tight">
                      {formatNumber(getWeekPoints(item))}
                    </div>
                  </div>

                  <div className="text-center">
                    <div className="text-[9px] font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">
                      Pts
                    </div>

                    <div className="text-xs font-black text-gray-900 dark:text-white leading-tight">
                      {formatNumber(getTeamPoints(item))}
                    </div>
                  </div>

                  <div className="text-center">
                    <div className="text-[9px] font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">
                      Valor
                    </div>

                    <div className="text-xs font-black text-gray-900 dark:text-white leading-tight">
                      {formatCurrency(getTeamValue(item))}
                    </div>
                  </div>

                  <div className="text-center">
                    <div className="text-[9px] font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">
                      {real ? 'Saldo' : 'Saldo~'}
                    </div>

                    <div className="text-xs font-black text-green-600 dark:text-green-400 leading-tight">
                      {balance === null
                        ? (isLoadingTeamMoney || isLoadingBalances ? '...' : 'N/D')
                        : formatCurrency(balance)}
                    </div>

                    {estimated !== null && (
                      <div className="text-[9px] text-gray-500 dark:text-gray-400 leading-tight mt-0.5">
                        est. {formatCurrency(estimated)}
                      </div>
                    )}
                  </div>

                  <div className="text-center">
                    <div className="text-[9px] font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">
                      24h
                    </div>

                    <div className={`text-xs font-black leading-tight ${
                      getTeamMarketIncrease(item) > 0
                        ? 'text-green-600 dark:text-green-400'
                        : getTeamMarketIncrease(item) < 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-gray-600 dark:text-gray-400'
                    }`}>
                      {formatMarketChange(getTeamMarketIncrease(item))}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {sortedStandings.length === 0 && (
        <div className="card p-12 text-center">
          <Trophy className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            No hay datos de clasificación
          </h3>
          <p className="text-gray-500 dark:text-gray-400">
            Los datos de clasificación se cargarán cuando estén disponibles
          </p>
        </div>
      )}
    </div>
  );
};

export default Standings;