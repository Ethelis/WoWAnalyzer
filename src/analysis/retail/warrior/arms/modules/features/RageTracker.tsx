import SPELLS from 'common/SPELLS';
import TALENTS from 'common/TALENTS/warrior';
import HIT_TYPES from 'game/HIT_TYPES';
import RESOURCE_TYPES from 'game/RESOURCE_TYPES';
import { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, { CastEvent, DamageEvent } from 'parser/core/Events';
import ResourceTracker from 'parser/shared/modules/resources/resourcetracker/ResourceTracker';

const RAGE_PER_MELEE_HIT = 25;

class RageUsage extends ResourceTracker {
  lastMeleeTaken = 0;
  meleeCount = 0;
  lastMeleeTimestamp = 0;

  private usesWarlordsTorment = false;
  private usesWarMachine = false;

  constructor(options: Options) {
    super(options);
    this.resource = RESOURCE_TYPES.RAGE;
    this.usesWarlordsTorment = this.selectedCombatant.hasTalent(TALENTS.WARLORDS_TORMENT_TALENT);
    this.usesWarMachine = this.selectedCombatant.hasTalent(TALENTS.WAR_MACHINE_ARMS_TALENT);
    this.addEventListener(Events.damage.by(SELECTED_PLAYER).spell(SPELLS.MELEE), this.onDamage);
    //the rage refund from improved execute.
    if (!this.selectedCombatant.hasTalent(TALENTS.IMPROVED_EXECUTE_ARMS_TALENT)) {
      return;
    }
    this.addEventListener(
      Events.cast.by(SELECTED_PLAYER).spell(SPELLS.EXECUTE_GLYPHED),
      this.onCastExecute,
    );
  }

  getAdjustedCost(event: CastEvent) {
    if (event.resourceCost && event.resourceCost[this.resource.id] !== undefined) {
      return event.resourceCost[this.resource.id];
    }
    const resource = super.getResource(event);
    if (!resource) {
      return;
    }
    return resource.cost;
  }

  onCastExecute(event: CastEvent) {
    //the cost for execute is multiplied by 10 to avoid floating point numbers.
    //just divide it by 10 again to get the more accurate number.
    const cost = (this.getAdjustedCost(event) || 0) / 10;
    if (cost !== 0) {
      this.processInvisibleEnergize(
        SPELLS.EXECUTE.id,
        cost / 10, //always assume the target survives, get 10% refund.
        event.timestamp,
      );
    }
  }

  onDamage(event: DamageEvent) {
    if (event.ability.guid !== 1 || event.timestamp === this.lastMeleeTimestamp) {
      return;
    }
    this.lastMeleeTimestamp = event.timestamp;
    this.meleeCount += 1;

    const rageMultiplier =
      this.usesWarlordsTorment &&
      this.selectedCombatant.hasBuff(SPELLS.RECKLESSNESS.id, event.timestamp)
        ? 2
        : 1;

    if (event.hitType === HIT_TYPES.CRIT) {
      this.processInvisibleEnergize(
        SPELLS.RAGE_AUTO_ATTACKS.id,
        RAGE_PER_MELEE_HIT * (this.usesWarMachine ? 1.2 : 1.1) * rageMultiplier,
        event.timestamp,
      );
    } else if (event.hitType === HIT_TYPES.NORMAL) {
      this.processInvisibleEnergize(
        SPELLS.RAGE_AUTO_ATTACKS.id,
        RAGE_PER_MELEE_HIT * (this.usesWarMachine ? 1.1 : 1) * rageMultiplier,
        event.timestamp,
      );
    }
  }
}

export default RageUsage;
