import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trophy } from 'lucide-react';
import { fantasyAPI } from '../../../services/api';
import { useCurrentWeek } from '../../../hooks/useCurrentWeek';
import { flattenPositionKeyedPlayers } from '../../../utils/formationUtils';
import { formatNumber, getPositionName, getPositionColor } from '../../../utils/helpers';

const CHUNK = 5; // simultaneous requests when loading past jornadas
const MEDAL_COLORS = ['text-yellow-500', 'text-gray-400', 'text-orange-500'];

/**
 * Points each player made FOR this manager: sum, over every jornada played,
 * of the player's weekly points in weeks where he was in this manager's
 * lineup (same source as the /lineup view: playerMaster.lastStats).
 */
const fetchManagerPoints = async (queryClient, teamId, currentWeek) => {
    const weeks = Array.from({ length: currentWeek }, (_, i) => i + 1);
    const byPlayer = new Map();

    for (let i = 0; i < weeks.length; i += CHUNK) {
        const chunk = weeks.slice(i, i + CHUNK);
        const results = await Promise.allSettled(chunk.map((week) =>
            queryClient.fetchQuery({
                queryKey: ['teamLineupWeek', teamId, week],
                queryFn: () => fantasyAPI.getTeamLineup(teamId, week),
                // Past jornadas never change; the current one may still move.
                staleTime: week < currentWeek ? Infinity : 2 * 60 * 1000,
                gcTime: 24 * 60 * 60 * 1000,
            })
        ));

        results.forEach((res, idx) => {
            if (res.status !== 'fulfilled') return;
            const week = chunk[idx];
            const lineup = res.value?.data || res.value;
            flattenPositionKeyedPlayers(lineup?.formation).forEach((entry) => {
                const player = entry.playerMaster;
                if (!player?.id) return;
                const stat = Array.isArray(player.lastStats)
                    ? player.lastStats.find((s) => s.weekNumber === week)
                    : null;
                const points = Number(stat?.totalPoints) || 0;
                const key = String(player.id);
                const acc = byPlayer.get(key) || { player, points: 0, weeks: 0 };
                acc.points += points;
                acc.weeks += 1;
                acc.player = player;
                byPlayer.set(key, acc);
            });
        });
    }

    return Array.from(byPlayer.values());
};

const TeamTopScorers = ({ teamId, playersData, onPlayerClick, limit = 3 }) => {
    const queryClient = useQueryClient();
    const { weekNumber: currentWeek } = useCurrentWeek();

    const { data, isLoading } = useQuery({
        queryKey: ['managerTopScorers', teamId, currentWeek],
        queryFn: () => fetchManagerPoints(queryClient, teamId, currentWeek),
        enabled: !!teamId && !!currentWeek,
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        retry: false,
    });

    if (isLoading) {
        return (
            <div className="card p-4 sm:p-6 text-sm text-gray-500 dark:text-gray-400">
                Calculando los máximos anotadores del manager…
            </div>
        );
    }

    const top = (data || [])
        .sort((a, b) =>
            (b.points - a.points) ||
            ((b.player.marketValue || 0) - (a.player.marketValue || 0)))
        .slice(0, limit);

    if (top.length === 0 || top[0].points <= 0) return null;

    const currentSquad = new Map(
        (playersData || []).map((pt) => [String(pt.playerMaster?.id), pt])
    );

    return (
        <section aria-labelledby="top-scorers-title" className="card p-4 sm:p-6">
            <h2
                id="top-scorers-title"
                className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white mb-1"
            >
                <Trophy className="w-5 h-5 text-yellow-500" aria-hidden="true" />
                Top {top.length} jugadores que más puntos le han dado
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                Solo cuentan los puntos de las jornadas en que el jugador estuvo en su alineación.
            </p>

            <ol className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {top.map(({ player, points, weeks }, index) => {
                    const playerTeam = currentSquad.get(String(player.id));
                    const image = player.images?.transparent?.['256x256'];
                    const name = player.nickname || player.name;
                    return (
                        <li key={player.id}>
                            <button
                                type="button"
                                onClick={() => onPlayerClick(player, playerTeam || {})}
                                className="w-full flex items-center gap-4 p-3 rounded-xl text-left bg-gradient-to-br from-white to-gray-50 dark:from-gray-900 dark:to-gray-800 border border-gray-200 dark:border-gray-700 hover:shadow-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
                                aria-label={`Puesto ${index + 1}: ${name}, ${points} puntos en ${weeks} jornadas`}
                            >
                                <span className={`text-2xl font-black w-7 text-center flex-shrink-0 ${MEDAL_COLORS[index] || 'text-gray-500'}`}>
                                    {index + 1}
                                </span>

                                <div className="w-14 h-14 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden flex-shrink-0 flex items-center justify-center">
                                    {image ? (
                                        <img
                                            src={image}
                                            alt={name}
                                            className="w-full h-full object-contain"
                                            onError={(e) => { e.target.style.display = 'none'; }}
                                        />
                                    ) : (
                                        <span className="text-lg font-bold text-gray-500 dark:text-gray-400">
                                            {(name || '?').charAt(0).toUpperCase()}
                                        </span>
                                    )}
                                </div>

                                <div className="flex-1 min-w-0">
                                    <p className="font-semibold text-gray-900 dark:text-white truncate">{name}</p>
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getPositionColor(player.positionId)}`}>
                                            {((p) => p === 'Centrocampista' ? 'Medio' : p)(getPositionName(player.positionId))}
                                        </span>
                                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                                            {weeks} {weeks === 1 ? 'jornada' : 'jornadas'}
                                            {!playerTeam && ' y se fue' || ' y sumando'}
                                        </span>
                                    </div>
                                </div>

                                <div className="text-right flex-shrink-0">
                                    <p className="text-xl font-bold text-primary-600 dark:text-primary-400">
                                        {formatNumber(points)}
                                    </p>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">pts</p>
                                </div>
                            </button>
                        </li>
                    );
                })}
            </ol>
        </section>
    );
};

export default TeamTopScorers;