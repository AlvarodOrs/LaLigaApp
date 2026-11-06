import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trophy } from 'lucide-react';
import { fantasyAPI } from '../../../services/api';
import { useCurrentWeek } from '../../../hooks/useCurrentWeek';
import { flattenPositionKeyedPlayers } from '../../../utils/formationUtils';
import { formatNumber, getPositionName, getPositionColor } from '../../../utils/helpers';

const CHUNK = 5; // simultaneous requests when loading past jornadas

// Podium styling, indexed by rank (0 = 1st, 1 = 2nd, 2 = 3rd).
// Full class strings so Tailwind can detect them.
const PODIUM = [
    {
        height: 'h-48 sm:h-56',
        accent: 'border-t-yellow-400',
        medal: 'bg-yellow-500',
        ring: 'ring-yellow-400',
        glow: 'from-yellow-400/20',
        avatar: 'w-16 h-16 sm:w-24 sm:h-24',
    },
    {
        height: 'h-40 sm:h-44',
        accent: 'border-t-gray-400',
        medal: 'bg-gray-400',
        ring: 'ring-gray-300 dark:ring-gray-500',
        glow: 'from-gray-400/20',
        avatar: 'w-14 h-14 sm:w-20 sm:h-20',
    },
    {
        height: 'h-32 sm:h-36',
        accent: 'border-t-orange-500',
        medal: 'bg-orange-500',
        ring: 'ring-orange-400',
        glow: 'from-orange-500/20',
        avatar: 'w-12 h-12 sm:w-16 sm:h-16',
    },
];

// Visual order left → right: 2nd, 1st, 3rd
const PODIUM_ORDER = [1, 0, 2];

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

    // Podium holds at most 3 places
    const top = [...(data || [])]
        .sort((a, b) =>
            (b.points - a.points) ||
            ((b.player.marketValue || 0) - (a.player.marketValue || 0)))
        .slice(0, Math.min(limit, 3));

    if (top.length === 0 || top[0].points <= 0) return null;

    const currentSquad = new Map(
        (playersData || []).map((pt) => [String(pt.playerMaster?.id), pt])
    );

    // Re-arrange as 2nd, 1st, 3rd (skipping places that don't exist)
    const podiumSlots = PODIUM_ORDER.filter((rank) => top[rank]);

    return (
        <section aria-labelledby="top-scorers-title" className="card p-4 sm:p-6">
            <h2
                id="top-scorers-title"
                className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white mb-1"
            >
                <Trophy className="w-5 h-5 text-yellow-500" aria-hidden="true" />
                Los que más puntos le han dado
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">
                Contando solo las jornadas en las que estuvieron en su alineación.
            </p>

            <ol className="grid grid-cols-3 gap-2 sm:gap-4 items-end max-w-2xl mx-auto">
                {podiumSlots.map((rank) => {
                    const { player, points, weeks } = top[rank];
                    const style = PODIUM[rank];
                    const playerTeam = currentSquad.get(String(player.id));
                    const image = player.images?.transparent?.['256x256'];
                    const name = player.nickname || player.name;
                    const positionName = ((p) => p === 'Centrocampista' ? 'Medio' : p)(getPositionName(player.positionId));

                    return (
                        <li key={player.id} className="min-w-0">
                            <button
                                type="button"
                                onClick={() => onPlayerClick(player, playerTeam || {})}
                                className="group w-full flex flex-col items-center rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500"
                                aria-label={`Puesto ${rank + 1}: ${name}, ${points} puntos en ${weeks} jornadas`}
                            >
                                {/* Player picture on top, with a little medal */}
                                <div className="relative mb-3 transition-transform duration-200 group-hover:-translate-y-1">
                                    <div
                                        className={`${style.avatar} rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden flex items-center justify-center ring-2 ${style.ring} ring-offset-2 ring-offset-white dark:ring-offset-gray-900 shadow-md`}
                                    >
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
                                    <span
                                        className={`absolute -bottom-1 -right-1 w-6 h-6 sm:w-7 sm:h-7 rounded-full ${style.medal} text-white text-xs sm:text-sm font-black flex items-center justify-center border-2 border-white dark:border-gray-900 shadow`}
                                        aria-hidden="true"
                                    >
                                        {rank + 1}
                                    </span>
                                </div>

                                {/* Name + position */}
                                <p className="w-full text-center text-xs sm:text-sm font-semibold text-gray-900 dark:text-white truncate">
                                    {name}
                                </p>
                                <span className={`mt-1 mb-3 px-2 py-0.5 rounded-full text-[10px] font-bold ${getPositionColor(player.positionId)}`}>
                                    {positionName}
                                </span>

                                {/* Podium block: same card look as before, with a medal-coloured top edge */}
                                <div
                                    className={`${style.height} w-full relative overflow-hidden rounded-t-xl border border-b-0 border-t-4 ${style.accent} border-x-gray-200 dark:border-x-gray-700 bg-gradient-to-br from-white to-gray-50 dark:from-gray-900 dark:to-gray-800 group-hover:shadow-lg transition-shadow duration-200 flex flex-col items-center justify-start pt-3 px-1`}
                                >
                                    <div className={`absolute inset-x-0 top-0 h-16 bg-gradient-to-b ${style.glow} to-transparent pointer-events-none`} aria-hidden="true" />
                                    <p className="relative text-xl sm:text-2xl font-bold text-primary-600 dark:text-primary-400 leading-none">
                                        {formatNumber(points)}
                                    </p>
                                    <p className="relative text-[10px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5">pts</p>
                                    <p className="relative mt-2 text-[10px] sm:text-xs text-gray-500 dark:text-gray-400 text-center leading-tight">
                                        {weeks} {weeks === 1 ? 'jornada' : 'jornadas'}
                                        <br />
                                        {!playerTeam ? 'ya se fue' : 'y sigue'}
                                    </p>
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