import { FocusTracker } from 'analysis/retail/hunter/shared';
import SPELLS from 'common/SPELLS';
import TALENTS from 'common/TALENTS/hunter';
import { SpellLink } from 'interface';
import Analyzer from 'parser/core/Analyzer';
import { When } from 'parser/core/ParseResults';
import resourceSuggest from 'parser/shared/modules/resources/resourcetracker/ResourceSuggest';

class Focus extends Analyzer {
  static dependencies = {
    focusTracker: FocusTracker,
  };

  protected focusTracker!: FocusTracker;

  suggestions(when: When) {
    resourceSuggest(when, this.focusTracker, {
      spell: TALENTS.KILL_COMMAND_SURVIVAL_TALENT,
      minor: 0.05,
      avg: 0.075,
      major: 0.1,
      extraSuggestion: (
        <>
          Try to keep focus below max by using <SpellLink spell={SPELLS.SERPENT_STING_SV} />,{' '}
          <SpellLink spell={TALENTS.MONGOOSE_BITE_TALENT} /> or{' '}
          <SpellLink spell={TALENTS.RAPTOR_STRIKE_TALENT} />.
        </>
      ),
    });
  }
}

export default Focus;
