// Type-boosting held items shared by the event-core damage handlers (effects.ts).
// The former ability/item/stat multiplier functions moved to effects.ts as
// BasePower / ModifyDamage / ModifyAtk handlers during the event-core refactor.

// Type-boosting held items -> the type they boost (×1.2).
export const TYPE_BOOST_ITEMS: Record<string, string> = {
    charcoal: 'Fire', mysticwater: 'Water', magnet: 'Electric', miracleseed: 'Grass',
    nevermeltice: 'Ice', blackbelt: 'Fighting', poisonbarb: 'Poison', softsand: 'Ground',
    sharpbeak: 'Flying', twistedspoon: 'Psychic', silverpowder: 'Bug', hardstone: 'Rock',
    spelltag: 'Ghost', dragonfang: 'Dragon', blackglasses: 'Dark', metalcoat: 'Steel',
    silkscarf: 'Normal', fairyfeather: 'Fairy',
};
