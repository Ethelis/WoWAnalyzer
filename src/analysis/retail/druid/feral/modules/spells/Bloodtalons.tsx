import { formatPercentage } from 'common/format';
import SPELLS from 'common/SPELLS';
import { SpellLink, SpellIcon } from 'interface';
import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, {
  AnyEvent,
  ApplyDebuffEvent,
  CastEvent,
  DamageEvent,
  RefreshDebuffEvent,
} from 'parser/core/Events';
import { ThresholdStyle, When } from 'parser/core/ParseResults';
import BoringSpellValueText from 'parser/ui/BoringSpellValueText';
import Statistic from 'parser/ui/Statistic';
import STATISTIC_ORDER from 'parser/ui/STATISTIC_ORDER';

import {
  BLOODTALONS_DAMAGE_BONUS,
  cdSpell,
  FINISHERS,
  LIONS_STRENGTH_DAMAGE_BONUS,
} from 'analysis/retail/druid/feral/constants';
import { isFromHardcast } from 'analysis/retail/druid/feral/normalizers/CastLinkNormalizer';
import ConvokeSpiritsFeral from 'analysis/retail/druid/feral/modules/spells/ConvokeSpiritsFeral';
import { TALENTS_DRUID } from 'common/TALENTS';
import { calculateEffectiveDamage } from 'parser/core/EventCalculateLib';
import { encodeEventTargetString } from 'parser/shared/modules/Enemies';
import AbilityTracker from 'parser/shared/modules/AbilityTracker';

const BUFFER_MS = 50;

const DEBUG = false;

/**
 * **Bloodtalons**
 * Spec Talent Tier 9
 *
 * When you use 3 different combo point-generating abilities within 4 sec,
 * the damage of your next 2 Rips or Ferocious Bites is increased by 25%.
 * --------------------------------
 * This module specifically tracks Ferocious Bite's benefit from Bloodtalons.
 * Rip benefits are handled in RipUptimeAndSnapshots.
 */
class Bloodtalons extends Analyzer {
  static dependencies = {
    abilityTracker: AbilityTracker,
    convokeSpirits: ConvokeSpiritsFeral,
  };

  protected abilityTracker!: AbilityTracker;
  protected convokeSpirits!: ConvokeSpiritsFeral;

  /** True iff the player has the Apex Predator's Craving legendary */
  hasApex: boolean;

  /** Bites cast with the Apex Predator's Craving buff */
  apexBites: number = 0;
  /** Bites cast by Convoke */
  convokeBites: number = 0;
  /** Hardcast bites during Berserk (and not buffed by APC) */
  berserkBites: number = 0;
  /** Hardcast bites that weren't buffed by APC or during Berserk */
  regBites: number = 0;

  /** Bites cast with the Apex Predator's Craving buff that were buffed with BT */
  apexBitesWithBt: number = 0;
  /** Bites cast by Convoke that were buffed with BT */
  convokeBitesWithBt: number = 0;
  /** Hardcast bites during Berserk (and not buffed by APC) that were buffed with BT */
  berserkBitesWithBt: number = 0;
  /** Hardcast bites that weren't buffed by APC that were buffed with BT */
  regBitesWithBt: number = 0;

  /** Rips cast */
  rips: number = 0;
  /** Rips cast that were buffed with BT */
  ripsWithBt: number = 0;

  /** Primal Wraths cast */
  primalWraths: number = 0;
  /** Primal Wraths cast that were buffed with BT */
  primalWrathsWithBt: number = 0;

  /**
   * Normally, every regular hardcast FB should be buffed by BT, but we allow the following exceptions:
   * * Player consumed BT on an Apex bite since the last finisher
   * * Player consumed BT on Convoke since the last finisher
   * * Player is Berserk/Incarn (might not be enough builders to proc BT due to crits)
   *
   * If none of these exceptions apply and the FB didn't benefit from BT, we increment this.
   */
  badBites: number = 0;
  /** Number of regular hardcast FB that either benefitted from BT or had an exception */
  correctBites: number = 0;
  /** If there has been an 'exception' case since the last finisher that makes it ok for
   * this finisher to be a Ferocious Bite unbuffed by BT */
  exceptionSinceLastFinisher: boolean = false;

  /** Total damage added by Bloodtalons  */
  btDamage: number = 0;
  /** The damage that could have been boosted by Bloodtalons, before the boost. */
  totalBoostableDamage: number = 0;
  /** The damage that was boosted by Bloodtalons, before the boost */
  baseBoostedDamage: number = 0;
  /** Set of target IDs whose last rip application had BT */
  targetsWithBtRip: Set<string> = new Set<string>();

  constructor(options: Options) {
    super(options);

    this.active = this.selectedCombatant.hasTalent(TALENTS_DRUID.BLOODTALONS_TALENT);
    this.hasApex = this.selectedCombatant.hasTalent(TALENTS_DRUID.APEX_PREDATORS_CRAVING_TALENT);

    // for tallying casts
    this.addEventListener(Events.cast.by(SELECTED_PLAYER).spell(FINISHERS), this.onFinisherCast);
    this.addEventListener(
      Events.damage.by(SELECTED_PLAYER).spell(SPELLS.FEROCIOUS_BITE),
      this.onFbDamage,
    );

    // for counting damage (Primal Wrath direct damage does not benefit from BT, hence its omission)
    this.addEventListener(
      Events.damage.by(SELECTED_PLAYER).spell([SPELLS.FEROCIOUS_BITE, SPELLS.RAMPANT_FEROCITY]),
      this.onBtDirect,
    );
    this.addEventListener(
      Events.damage.by(SELECTED_PLAYER).spell([SPELLS.RIP, SPELLS.TEAR_OPEN_WOUNDS]),
      this.onBtFromRip,
    );
    this.addEventListener(
      Events.applydebuff.by(SELECTED_PLAYER).spell(SPELLS.RIP),
      this.onRipApply,
    );
    this.addEventListener(
      Events.refreshdebuff.by(SELECTED_PLAYER).spell(SPELLS.RIP),
      this.onRipApply,
    );

    DEBUG && this.addEventListener(Events.fightend, this.onFightEnd);
  }

  onFightEnd() {
    console.log(`Correct Bites:${this.correctBites} / Bad Bites:${this.badBites}`);
  }

  onFinisherCast(event: CastEvent) {
    if (event.ability.guid === SPELLS.FEROCIOUS_BITE.id) {
      const fromApex =
        this.hasApex &&
        this.selectedCombatant.hasBuff(
          SPELLS.APEX_PREDATORS_CRAVING_BUFF.id,
          event.timestamp,
          BUFFER_MS,
        );
      const hasBt = this._hasBt(event);
      if (hasBt) {
        if (fromApex) {
          // consumed BT with an apex bite - this is an exception allowing real finisher to be missing BT
          this.exceptionSinceLastFinisher = true;
          this.apexBitesWithBt += 1;
          this.apexBites += 1;
          return; // apex bite isn't a 'real finisher' - don't want to reset exception tracker
        } else {
          // hardcast bite with BT
          this.correctBites += 1;
          if (this._isBerserkOrIncarn()) {
            this.berserkBitesWithBt += 1;
            this.berserkBites += 1;
          } else {
            this.regBitesWithBt += 1;
            this.regBites += 1;
          }
        }
      } else if (!fromApex) {
        // hardcast bite without BT - check if this is acceptable
        if (this.exceptionSinceLastFinisher || this._isBerserkOrIncarn()) {
          this.correctBites += 1;
        } else {
          this.badBites += 1;
        }
        // also increment the correct counter
        if (this._isBerserkOrIncarn()) {
          this.berserkBites += 1;
        } else {
          this.regBites += 1;
        }
      } else {
        // apex bite without BT
        this.apexBites += 1;
      }
    } else if (event.ability.guid === SPELLS.RIP.id) {
      if (this._hasBt(event)) {
        this.ripsWithBt += 1;
      }
      this.rips += 1;
    } else if (event.ability.guid === TALENTS_DRUID.PRIMAL_WRATH_TALENT.id) {
      if (this._hasBt(event)) {
        this.primalWrathsWithBt += 1;
      }
      this.primalWraths += 1;
    }

    this.exceptionSinceLastFinisher = false;
  }

  onFbDamage(event: DamageEvent) {
    if (!isFromHardcast(event) && this.convokeSpirits.isConvoking()) {
      // convoke bite
      if (this._hasBt(event)) {
        // consumed BT with a convoke bite - this is an exception allowing real finisher to be missing BT
        this.convokeBitesWithBt += 1;
        this.exceptionSinceLastFinisher = true;
      }
      this.convokeBites += 1;
    }
  }

  onBtDirect(event: DamageEvent) {
    this._tallyBtDamage(event, this._hasBt(event));
  }

  onBtFromRip(event: DamageEvent) {
    this._tallyBtDamage(event, this.targetsWithBtRip.has(encodeEventTargetString(event) || ''));
  }

  _tallyBtDamage(event: DamageEvent, benefittedFromBt: boolean) {
    const totalDamage = event.amount + (event.absorbed || 0);
    let btAdd = 0;
    if (benefittedFromBt) {
      btAdd = calculateEffectiveDamage(event, BLOODTALONS_DAMAGE_BONUS);
      this.btDamage += btAdd;
    }
    const baseDamage = totalDamage - btAdd;
    this.totalBoostableDamage += baseDamage;
    benefittedFromBt && (this.baseBoostedDamage += baseDamage);
  }

  onRipApply(event: ApplyDebuffEvent | RefreshDebuffEvent) {
    const targetString = encodeEventTargetString(event) || '';
    if (this._hasBt(event)) {
      this.targetsWithBtRip.add(targetString);
    } else {
      this.targetsWithBtRip.delete(targetString);
    }
  }

  _hasBt(event: AnyEvent): boolean {
    return this.selectedCombatant.hasBuff(SPELLS.BLOODTALONS_BUFF.id, event.timestamp, BUFFER_MS);
  }

  _isBerserkOrIncarn(): boolean {
    return (
      this.selectedCombatant.hasBuff(SPELLS.BERSERK.id) ||
      this.selectedCombatant.hasBuff(TALENTS_DRUID.INCARNATION_AVATAR_OF_ASHAMANE_TALENT.id)
    );
  }

  get totalRegularBites() {
    return this.badBites + this.correctBites;
  }

  get totalBites() {
    return this.apexBites + this.convokeBites + this.berserkBites + this.regBites;
  }

  get bitesWithBt() {
    return (
      this.apexBitesWithBt + this.convokeBitesWithBt + this.berserkBitesWithBt + this.regBitesWithBt
    );
  }

  get percentCorrectBites() {
    return this.totalRegularBites === 0 ? 1 : this.correctBites / this.totalRegularBites;
  }

  /** Percent of boostable damage that actually did benefit from BT */
  get percentBoosted() {
    return this.totalBoostableDamage === 0 ? 0 : this.baseBoostedDamage / this.totalBoostableDamage;
  }

  get correctFbSuggestionThresholds() {
    return {
      actual: this.percentCorrectBites,
      isLessThan: {
        minor: 1,
        average: 0.8,
        major: 0.5,
      },
      style: ThresholdStyle.PERCENTAGE,
    };
  }

  suggestions(when: When) {
    when(this.correctFbSuggestionThresholds).addSuggestion((suggest, actual, recommended) =>
      suggest(
        <>
          You are casting <SpellLink id={SPELLS.FEROCIOUS_BITE.id} /> without{' '}
          <SpellLink id={TALENTS_DRUID.BLOODTALONS_TALENT.id} />. With only a few exceptions, you
          should be able to buff each of your Bites with Bloodtalons.
          <br />
          <br />
          The exceptions are: you have <SpellLink id={SPELLS.BERSERK.id} /> or{' '}
          <SpellLink id={TALENTS_DRUID.INCARNATION_AVATAR_OF_ASHAMANE_TALENT.id} /> active and don't
          have enough combo builders between finishers to proc Bloodtalons, or your{' '}
          <SpellLink id={SPELLS.CONVOKE_SPIRITS.id} /> consumed Bloodtalons before your finisher
          {this.hasApex && (
            <>
              , or your <SpellLink id={SPELLS.APEX_PREDATORS_CRAVING.id} /> proc consumed
              Bloodtalons before your finisher
            </>
          )}
          . These exceptions are accounted for by the below statistic.
        </>,
      )
        .icon(TALENTS_DRUID.BLOODTALONS_TALENT.icon)
        .actual(`${formatPercentage(actual, 1)}% correct Bloodtalon Ferocious Bites.`)
        .recommended(`${formatPercentage(recommended, 0)}% is recommended`),
    );
  }

  // TODO guide subsection

  statistic() {
    const hasPw = this.selectedCombatant.hasTalent(TALENTS_DRUID.PRIMAL_WRATH_TALENT);
    return (
      <Statistic
        tooltip={
          <>
            The main statistic tracks how many of your Ferocious Bite and Rip casts benefitted from
            Bloodtalons. Your Rips {hasPw && 'and Primal Wraths '}should always be buffed by
            Bloodtalons, but there are several reasons why it might be impractical to buff every
            Bite, including being unable to proc it to avoid overcapping CPs during Berserk, or
            having more Bites than procs due to Apex Predator's Craving or Convoke the Spirits.
            <br />
            <br />
            Buffed Bite breakdown by source:
            <ul>
              <li>
                Regular Hardcasts:{' '}
                <strong>
                  {this.regBitesWithBt} / {this.regBites}
                </strong>
              </li>
              <li>
                <SpellLink id={cdSpell(this.selectedCombatant).id} /> Hardcasts:{' '}
                <strong>
                  {this.berserkBitesWithBt} / {this.berserkBites}
                </strong>
              </li>
              {this.convokeSpirits.active && (
                <li>
                  <SpellLink id={SPELLS.CONVOKE_SPIRITS.id} />:{' '}
                  <strong>
                    {this.convokeBitesWithBt} / {this.convokeBites}
                  </strong>
                </li>
              )}
              {this.hasApex && (
                <li>
                  <SpellLink id={SPELLS.APEX_PREDATORS_CRAVING.id} />:{' '}
                  <strong>
                    {this.apexBitesWithBt} / {this.apexBites}
                  </strong>
                </li>
              )}
            </ul>
            <br />
            Damage added due to <SpellLink id={TALENTS_DRUID.BLOODTALONS_TALENT.id} /> (opportunity
            cost not included):{' '}
            <strong>
              {formatPercentage(this.owner.getPercentageOfTotalDamageDone(this.btDamage))}%
            </strong>
            <br />
            <br />
            You applied Bloodtalons to <strong>
              {formatPercentage(this.percentBoosted, 1)}%
            </strong>{' '}
            of the damage that could possibly benefit from it. If this number falls below{' '}
            {formatPercentage(LIONS_STRENGTH_DAMAGE_BONUS / BLOODTALONS_DAMAGE_BONUS, 0)}%, you
            would have done more damage had you picked{' '}
            <SpellLink id={TALENTS_DRUID.LIONS_STRENGTH_TALENT.id}>BITEFORCE</SpellLink> instead.
          </>
        }
        size="flexible"
        position={STATISTIC_ORDER.CORE(40)}
      >
        <BoringSpellValueText spellId={TALENTS_DRUID.BLOODTALONS_TALENT.id}>
          <>
            <SpellIcon id={SPELLS.FEROCIOUS_BITE.id} /> {this.bitesWithBt} / {this.totalBites}{' '}
            <small>buffed</small>
            <br />
            <SpellIcon id={SPELLS.RIP.id} /> {this.ripsWithBt} / {this.rips} <small>buffed</small>
            {hasPw && (
              <>
                <br />
                <SpellIcon id={TALENTS_DRUID.PRIMAL_WRATH_TALENT.id} /> {this.primalWrathsWithBt} /{' '}
                {this.primalWraths} <small>buffed</small>
              </>
            )}
          </>
        </BoringSpellValueText>
      </Statistic>
    );
  }
}

export default Bloodtalons;
