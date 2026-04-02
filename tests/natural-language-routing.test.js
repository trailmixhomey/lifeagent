import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from '../lib/intent-classifier.js';

describe('Natural Language Routing', () => {
  describe('Deadline questions → canvas-sync', () => {
    const cases = [
      "what's due",
      "what do i have due",
      "anything due this week",
      "due dates",
      "what's coming up",
      "when is the essay due",
      "when's my next assignment",
      "do I have anything due tomorrow",
      "what are my deadlines",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to canvas-sync`, () => {
        assert.equal(classifyIntent(msg), 'canvas-sync');
      });
    }
  });

  describe('Grade questions → canvas-sync', () => {
    const cases = [
      "did I get my grade",
      "what did I get on the midterm",
      "grades",
      "how did I do",
      "midterm results",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to canvas-sync`, () => {
        assert.equal(classifyIntent(msg), 'canvas-sync');
      });
    }
  });

  describe('Planning requests → academic-planner', () => {
    const cases = [
      "help me plan",
      "plan my week",
      "when should I study",
      "schedule study time",
      "what should I work on",
      "what's most important",
      "what do I do first",
      "add study to my calendar",
      "put these on my calendar",
      "when should I start my essay",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to academic-planner`, () => {
        assert.equal(classifyIntent(msg), 'academic-planner');
      });
    }
  });

  describe('Stress → stress handler', () => {
    const cases = [
      "I have so much to do",
      "I'm stressed",
      "I'm overwhelmed",
      "I'm screwed",
      "I can't do this",
      "too much",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to stress handler`, () => {
        assert.equal(classifyIntent(msg), 'stress');
      });
    }
  });

  describe('Quiet requests → quiet handler', () => {
    const cases = [
      "stop",
      "quiet",
      "mute",
      "shut up",
      "shh",
      "leave me alone",
      "too many texts",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to quiet handler`, () => {
        assert.equal(classifyIntent(msg), 'quiet');
      });
    }
  });

  describe('Out of scope → polite decline', () => {
    const cases = [
      "help me write my essay",
      "what's the answer to question 3",
      "do my homework",
      "solve this problem",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to out-of-scope`, () => {
        assert.equal(classifyIntent(msg), 'out-of-scope');
      });
    }
  });

  describe('Reconnection → reconnect handler', () => {
    const cases = [
      "it's not showing my classes",
      "something's not working",
      "I can't see my classes",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to reconnect handler`, () => {
        assert.equal(classifyIntent(msg), 'reconnect');
      });
    }
  });
});
