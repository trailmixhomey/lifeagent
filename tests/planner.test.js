import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateEffort, formatHours, recordEffort } from '../lib/effort-estimator.js';
import { findSlots, rankSlots } from '../lib/availability-finder.js';

describe('Effort Estimator', () => {
  it('should return default estimates for known assignment types', () => {
    const types = {
      essay: { min: 4, max: 6 },
      problem_set: { min: 2, max: 3 },
      quiz: { min: 1, max: 2 },
      discussion: { min: 0.5, max: 1 },
      lab: { min: 2, max: 3 },
      presentation: { min: 2, max: 3 },
    };

    for (const [type, range] of Object.entries(types)) {
      const result = estimateEffort(
        { assignment_type: type, course_id: 1 },
        { entries: [] }
      );
      assert.ok(
        result.hours >= range.min && result.hours <= range.max,
        `${type} should be ${range.min}-${range.max}h, got ${result.hours}h`
      );
      assert.equal(result.source, 'default');
    }
  });

  it('should use personal history when available (2+ entries)', () => {
    const history = {
      entries: [
        { course_id: 1, assignment_type: 'problem_set', actual_hours: 1.5 },
        { course_id: 1, assignment_type: 'problem_set', actual_hours: 2.0 },
        { course_id: 1, assignment_type: 'problem_set', actual_hours: 2.5 },
      ],
    };

    const result = estimateEffort(
      { assignment_type: 'problem_set', course_id: 1 },
      history
    );
    assert.equal(result.hours, 2); // average of 1.5, 2, 2.5
    assert.equal(result.source, 'personal');
  });

  it('should fall back to default with fewer than 2 history entries', () => {
    const history = {
      entries: [
        { course_id: 1, assignment_type: 'essay', actual_hours: 3 },
      ],
    };

    const result = estimateEffort(
      { assignment_type: 'essay', course_id: 1 },
      history
    );
    assert.equal(result.source, 'default');
  });

  it('should only use history from the same course', () => {
    const history = {
      entries: [
        { course_id: 1, assignment_type: 'problem_set', actual_hours: 1 },
        { course_id: 1, assignment_type: 'problem_set', actual_hours: 1 },
        { course_id: 2, assignment_type: 'problem_set', actual_hours: 5 },
        { course_id: 2, assignment_type: 'problem_set', actual_hours: 5 },
      ],
    };

    const result1 = estimateEffort(
      { assignment_type: 'problem_set', course_id: 1 },
      history
    );
    assert.equal(result1.hours, 1);

    const result2 = estimateEffort(
      { assignment_type: 'problem_set', course_id: 2 },
      history
    );
    assert.equal(result2.hours, 5);
  });
});

describe('Format Hours', () => {
  it('should format hours into human-friendly strings', () => {
    assert.equal(formatHours(0.5), '30 minutes');
    assert.equal(formatHours(0.75), 'about 45 minutes');
    assert.equal(formatHours(1), 'about an hour');
    assert.equal(formatHours(1.5), 'about 90 minutes');
    assert.ok(formatHours(2.5).includes('2-3'));
    assert.ok(formatHours(3).includes('3'));
  });

  it('should never use 24-hour format', () => {
    for (let h = 0.5; h <= 10; h += 0.5) {
      const label = formatHours(h);
      assert.ok(!label.includes(':00'), `"${label}" should not use 24h format`);
    }
  });
});

describe('Record Effort', () => {
  it('should add entries to history', () => {
    const history = { entries: [] };
    recordEffort(history, {
      course_id: 1,
      assignment_type: 'essay',
      assignment_name: 'Essay 1',
      actual_hours: 4,
    });
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].actual_hours, 4);
  });

  it('should cap history at 100 entries', () => {
    const history = { entries: [] };
    for (let i = 0; i < 110; i++) {
      recordEffort(history, {
        course_id: 1,
        assignment_type: 'essay',
        assignment_name: `Essay ${i}`,
        actual_hours: 3,
      });
    }
    assert.equal(history.entries.length, 100);
  });
});

describe('Availability Finder', () => {
  it('should find slots around existing events', () => {
    const tz = 'America/Los_Angeles';
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const events = [
      {
        summary: 'Class',
        start: new Date(tomorrow.getTime() + 10 * 3600000).toISOString(), // 10am
        end: new Date(tomorrow.getTime() + 11 * 3600000).toISOString(),   // 11am
        allDay: false,
      },
    ];

    const slots = findSlots(events, {
      rangeStart: tomorrow,
      rangeEnd: new Date(tomorrow.getTime() + 24 * 3600000),
      durationHours: 1.5,
      timezone: tz,
    });

    assert.ok(slots.length > 0, 'Should find at least one slot');

    // Verify slots don't overlap with the 10-11am event (plus 30min gap)
    for (const slot of slots) {
      const eventStart = new Date(tomorrow.getTime() + 10 * 3600000 - 30 * 60000);
      const eventEnd = new Date(tomorrow.getTime() + 11 * 3600000 + 30 * 60000);
      const noOverlap = slot.end <= eventStart || slot.start >= eventEnd;
      assert.ok(noOverlap, `Slot ${slot.label} overlaps with event`);
    }
  });

  it('should rank weekday slots before weekend slots', () => {
    const slots = [
      { start: new Date('2026-10-11T14:00:00'), end: new Date('2026-10-11T16:00:00'), label: 'Sunday' },     // Sunday
      { start: new Date('2026-10-12T14:00:00'), end: new Date('2026-10-12T16:00:00'), label: 'Monday' },     // Monday
      { start: new Date('2026-10-10T14:00:00'), end: new Date('2026-10-10T16:00:00'), label: 'Saturday' },   // Saturday
    ];

    const ranked = rankSlots(slots);
    assert.equal(ranked[0].label, 'Monday');
  });
});
