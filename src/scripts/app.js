import Vue from 'vue';
import CombinePairsView from './views/App.vue';
import ChoiceListView from './views/ChoiceList.vue';
import TextChoiceView from './views/TextChoice.vue';
import ImageChoiceView from './views/ImageChoice.vue';
import PuzzleView from './views/Puzzle.vue';
import ResultIndicatorView from './views/ResultIndicator.vue';
import { EventDispatcher, getPath } from './components/globals';
import { setDefinitionOnXapiEvent, setResponseOnXApiEvent } from './components/xapi';
import { always, assoc, curry, equals, path, map, unless, zipWith } from 'ramda';
import appState from './components/app-state';
import { pairState } from './components/pair-state';
import choiceListName from './components/choice-list-name';
import defaultTranslations from './components/default-translations';
import shuffle from 'shuffle-array';
import { mapIndexed } from './components/array-utils';
import KeyboardMixin from './mixins/keyboard';

// Register components
Vue.mixin(KeyboardMixin);
Vue.component('puzzle', PuzzleView);
Vue.component('textChoice', TextChoiceView);
Vue.component('imageChoice', ImageChoiceView);
Vue.component('resultIndicator', ResultIndicatorView);

/**
 * Returns the absolute path, if a path exists
 *
 * @param {string} path
 * @param {string} contentId
 */
const getAbsolutePath = (path, contentId) => path ? getPath(path, contentId) : undefined;

/**
 * @typedef {object} PairConfig
 * @property {string} image
 * @property {string} source
 * @property {string} target
 */
/**
 * @typedef {object} Choice
 * @property {number} id
 * @property {string} title
 * @property {string} image
 * @property {pairState} state
 * @property {number} position
 */
/**
 * @typedef {object} Pair
 * @property {Choice} source
 * @property {Choice} target
 */
/**
 * @typedef {object} CurrentState
 * @property {number[]} source
 * @property {number[]} target
 * @property {pairState[]} pairStates
 */

/**
 * Orders the choices in a list based on a previous state
 *
 * @param {number[]} order
 * @param {Choice[]} choices
 * return {Choice[]}
 */
const orderChoices = curry((order, choices) => map(index => choices[index], order));

const initPosition = mapIndexed((choice, index) => assoc('position', index, choice));

/**
 * Initializes choices
 *
 * @param {PairConfig[]} pairConfigs
 * @param {choiceListName} side
 * @param {string} contentId
 * @param {CurrentState} previousState
 *
 * @return {Choice[]}
 */
const initPairs = (pairConfigs, side, contentId, previousState) => {
  const choices = pairConfigs.map((config, index) => ({
    id: index,
    title: config[side],
    state: pairState.NONE,
    image: getAbsolutePath(path(['image', 'path'], config), contentId),
    position: index
  }));

  if(previousState && previousState[side]) {
    const orderedChoices = orderChoices(previousState[side], choices);
    return initPosition(zipWith(assoc('state'), previousState.pairStates, orderedChoices));
  }
  else {
    return initPosition(shuffle(choices));
  }
};

/**
 * Any choice with a state, is given state "MATCHED"
 *
 * @function
 * @param {pairState} state
 * @return {pairState}
 */
const removeSuccessState =  unless(equals(pairState.NONE), always(pairState.MATCHED));

/**
 * @class
 * @extends {EventDispatcher}
 */
export default class App extends EventDispatcher {
  /**
   * @constructor
   *
   * @param {object} config
   * @param {PairConfig[]} config.pairs
   * @param {string} config.title
   * @param {string} config.choiceType
   * @param {object} config.l10n
   * @param {object} config.behaviour
   * @param {boolean} config.behaviour.enableRetry
   * @param {boolean} config.behaviour.enableSolutionsButton
   * @param {number} config.behaviour.passPercentage
   * @param {string} contentId
   * @param {object} contentData
   * @param {CurrentState|undefined} contentData.previousState
   */
  constructor(config, contentId, contentData = {}) {
    super();

    contentData.previousState = undefined;

    const rootElement = document.createElement('div');

    // creates the configs for the two vertical lists
    const sourceList = initPairs(config.pairs, choiceListName.SOURCE, contentId, contentData.previousState);
    const targetList = initPairs(config.pairs, choiceListName.TARGET, contentId, contentData.previousState);

    // defaultTranslations can be replaced by a flat json language file .en
    const i18n = Object.assign({}, defaultTranslations, config.l10n);
    const maxScore = config.pairs.length;

    // initiates the view model
    const viewModel = new Vue({
      ...CombinePairsView,
      components: {
        choiceList: ChoiceListView
      }
    });

    viewModel.choiceType = config.choiceType;
    viewModel.title = config.title;
    viewModel.pairsLength = maxScore;
    viewModel.sourceList = sourceList;
    viewModel.targetList = targetList;
    viewModel.enableRetry = config.behaviour.enableRetry;
    viewModel.enableSolutionsButton = config.behaviour.enableSolutionsButton;
    viewModel.i18n = i18n;

    // Resize on state change
    viewModel.$watch('state', () => this.trigger('resize'));

    // propagate 'interacted' event
    viewModel.$on('interacted', () => {
      this.triggerXAPI('interacted');
    });

    // propagate answered event
    viewModel.$on('answered', ({ pairs }) => {
      const score = viewModel.getScore();
      const event = this.createXAPIEventTemplate('answered');
      event.setScoredResult(score, maxScore, this, true, (100 * score / maxScore) >= config.behaviour.passPercentage);
      setDefinitionOnXapiEvent(event, config.title, pairs);
      setResponseOnXApiEvent(event, pairs);
      this.trigger(event)
    });

    /**
     * Attach library to wrapper
     *
     * @param {jQuery} $wrapper
     */
    this.attach = function ($wrapper) {
      $wrapper.get(0).appendChild(rootElement);
      viewModel.$mount(rootElement);
    };

    /**
     * Returns the current state of the application
     * @return {CurrentState}
     */
    this.getCurrentState = () => {
      const { source, target } = viewModel.getCurrentState();

      return {
        pairStates: map(removeSuccessState, source.states),
        [choiceListName.SOURCE]: source.ids,
        [choiceListName.TARGET]: target.ids
      };
    };

    /**
     * Returns true if answers have been given
     *
     * @return {boolean}
     */
    this.getAnswerGiven = () => viewModel.getAnswerGiven();

    /**
     * Returns the score for this task
     *
     * @return {number}
     */
    this.getScore = () => viewModel.getScore();

    /**
     * Returns the max score for this task
     *
     * @return {number}
     */
    this.getMaxScore = () =>  maxScore;

    /**
     * Displays the solution(s) for this task, should also hide all buttons.
     */
    this.showSolutions = () => {
      viewModel.showSolution();
      viewModel.state = appState.GLOBAL_SHOW_SOLUTION;
    };

    /**
     *  Resets the task to its initial state
     */
    this.resetTask = () => viewModel.retry();

    /**
     * Retrieves the xAPI data necessary for generating result reports.
     */
    this.getXAPIData = () => {

    };
  }
}