import type { TeamDetail } from '@/modules/api/endpoints';
import type { AnalysisMember } from '@/lib/team-analysis';

// Map the team-detail member shape onto the analysis lib's minimal shape.
// Ability is passed as a display name so the lib's immunity/resist tables match.
// Shared by the Coverage tab and the meta-matrix view.
export function toAnalysisMembers(team: TeamDetail): AnalysisMember[] {
    return team.members.map((m) => ({
        id: m.id,
        slot: m.slot,
        pokemonId: m.pokemon.id,
        displayName: m.pokemon.displayName,
        type1: m.pokemon.type1,
        type2: m.pokemon.type2,
        ability: m.ability.displayName,
        moves: m.moves.map((mv) => ({ displayName: mv.displayName, type: mv.type, power: mv.power, damageClass: mv.damageClass })),
    }));
}
