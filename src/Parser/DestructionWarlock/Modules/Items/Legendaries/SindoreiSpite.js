import Module from 'Parser/Core/Module';
import Combatants from 'Parser/Core/Modules/Combatants';
import SPELLS from 'common/SPELLS';
import ITEMS from 'common/ITEMS';
import { formatNumber } from 'common/format';

import getDamageBonus from '../../WarlockCore/getDamageBonus';

const SINDOREI_SPITE_DAMAGE_BONUS = 0.15;

class SindoreiSpite extends Module {
  static dependencies = {
    combatants: Combatants,
  };

  bonusDmg = 0;

  on_initialized() {
    this.active = this.combatants.selected.hasWrists(ITEMS.SINDOREI_SPITE.id);
  }

  on_byPlayerPet_damage(event) {
    if (this.combatants.selected.hasBuff(SPELLS.SINDOREI_SPITE_BUFF.id, event.timestamp)) {
      this.bonusDmg += getDamageBonus(event, SINDOREI_SPITE_DAMAGE_BONUS);
    }
  }

  on_byPlayer_damage(event) {
    if (this.combatants.selected.hasBuff(SPELLS.SINDOREI_SPITE_BUFF.id, event.timestamp)) {
      this.bonusDmg += getDamageBonus(event, SINDOREI_SPITE_DAMAGE_BONUS);
    }
  }

  item() {
    return {
      item: ITEMS.SINDOREI_SPITE,
      result: `${formatNumber(this.bonusDmg)} damage contributed - ${this.owner.formatItemDamageDone(this.bonusDmg)}`,
    };
  }
}

export default SindoreiSpite;
