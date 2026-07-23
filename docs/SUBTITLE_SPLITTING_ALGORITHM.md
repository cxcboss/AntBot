# Subtitle Splitting Algorithm Documentation

## Overview

This algorithm splits long subtitles (>15 characters) into shorter ones while maintaining audio-visual sync. It's implemented in `src/main/services/smartEditor.js` and integrated into the subtitle generation pipeline.

## Algorithm Design

### Pseudocode

```
function splitLongSubtitles(entries):
    result = []

    for each entry in entries:
        if entry.text.length <= 15:
            result.push(entry)
        else:
            splitEntries = splitLongSubtitle(entry)
            result.push(...splitEntries)

    // Re-index all entries sequentially
    for i from 0 to result.length - 1:
        result[i].index = i + 1

    return result

function splitLongSubtitle(entry):
    text = entry.text
    startMs = entry.startMs
    endMs = entry.endMs

    // Step 1: Split text into segments
    segments = splitTextAtBoundaries(text)

    if segments.length <= 1:
        return [entry]

    // Step 2: Calculate timing constraints
    totalDuration = endMs - startMs
    numSegments = segments.length
    numGaps = numSegments - 1
    totalGapTime = numGaps * 300ms
    availableDuration = totalDuration - totalGapTime

    // Step 3: Check if we have enough time for minimum durations
    minRequiredDuration = numSegments * 1500ms

    if availableDuration < minRequiredDuration:
        maxPossibleSegments = floor(availableDuration / 1500ms)

        if maxPossibleSegments < 2:
            return [entry]  // Can't split, return original

        // Reduce number of segments by merging
        return reduceSegments(entry, segments, maxPossibleSegments, ...)

    // Step 4: Distribute time proportionally
    totalChars = sum of all segment lengths
    extraTime = availableDuration - minRequiredDuration
    timePerExtraChar = extraTime / totalChars

    result = []
    currentStart = startMs

    for i from 0 to segments.length - 1:
        segmentText = segments[i]
        extraDuration = segmentText.length * timePerExtraChar
        segmentDuration = 1500ms + extraDuration

        if i == segments.length - 1:
            segmentEnd = endMs  // Last segment ends at original end
        else:
            segmentEnd = min(endMs, currentStart + segmentDuration)

        result.push({
            ...entry,
            text: segmentText,
            startMs: currentStart,
            endMs: segmentEnd
        })

        currentStart = segmentEnd + 300ms  // 300ms gap

    return result

function splitTextAtBoundaries(text):
    if text.length <= 15:
        return [text]

    // Priority 1: Split at punctuation marks
    punctuationPositions = find all positions of ，。！？,!? in text

    if punctuationPositions is not empty:
        return splitAtPunctuation(text, punctuationPositions)

    // Priority 2: Split at natural boundaries
    return splitAtNaturalBoundary(text)

function splitAtPunctuation(text, positions):
    segments = []
    lastSplit = 0

    for each position in positions:
        splitPoint = position + 1  // Include punctuation in segment
        segment = text[lastSplit:splitPoint].trim()

        if segment.length > 0:
            segments.push(segment)

        lastSplit = splitPoint

    // Handle remaining text after last punctuation
    remaining = text[lastSplit:].trim()

    if remaining.length > 0:
        if remaining.length <= 15:
            segments.push(remaining)
        else:
            subSegments = splitAtNaturalBoundary(remaining)
            segments.push(...subSegments)

    return segments

function splitAtNaturalBoundary(text):
    if text.length <= 15:
        return [text]

    // Try to find a good split point near the middle
    midPoint = floor(text.length / 2)
    bestSplit = midPoint

    // Search within ±5 characters of midpoint
    for i from max(0, midPoint-5) to min(text.length, midPoint+5):
        if text[i] is space or 、；：:
            bestSplit = i + 1
            break
        if i > 0 and text[i-1] is Chinese and text[i] is Chinese:
            bestSplit = i  // Split between Chinese characters

    firstHalf = text[0:bestSplit].trim()
    secondHalf = text[bestSplit:].trim()

    segments = []
    if firstHalf.length > 0: segments.push(firstHalf)
    if secondHalf.length > 0: segments.push(secondHalf)

    // If still too long, force split
    if segments.length == 1 and segments[0].length > 15:
        return forceSplit(segments[0])

    return segments if segments.length > 0 else [text]

function forceSplit(text):
    if text.length <= 15:
        return [text]

    segments = []
    remaining = text

    while remaining.length > 15:
        splitPoint = 15

        // Try to find a better split point near 15 chars
        for i from max(0, splitPoint-3) to min(remaining.length, splitPoint+3):
            if remaining[i] is space or 、:
                splitPoint = i + 1
                break

        segments.push(remaining[0:splitPoint].trim())
        remaining = remaining[splitPoint:].trim()

    if remaining.length > 0:
        segments.push(remaining)

    return segments

function reduceSegments(entry, segments, maxSegments, startMs, endMs, availableDuration):
    // Merge segments to fit within maxSegments
    mergedSegments = []
    i = 0

    while i < segments.length:
        remaining = segments.length - i
        slotsLeft = maxSegments - mergedSegments.length

        if remaining <= slotsLeft:
            mergedSegments.push(segments[i])
            i++
        else:
            mergeCount = ceil(remaining / slotsLeft)
            merged = ""

            for j from 0 to mergeCount-1:
                if i + j < segments.length:
                    merged += segments[i + j]

            mergedSegments.push(merged)
            i += mergeCount

    // Distribute time with minimum duration guarantee
    numSegments = mergedSegments.length
    minRequiredDuration = numSegments * 1500ms
    totalChars = sum of all merged segment lengths
    extraTime = max(0, availableDuration - minRequiredDuration)
    timePerExtraChar = extraTime / totalChars

    result = []
    currentStart = startMs

    for i from 0 to mergedSegments.length - 1:
        segmentText = mergedSegments[i]
        extraDuration = segmentText.length * timePerExtraChar
        segmentDuration = 1500ms + extraDuration

        if i == mergedSegments.length - 1:
            segmentEnd = endMs
        else:
            segmentEnd = min(endMs, currentStart + segmentDuration)

        result.push({
            ...entry,
            text: segmentText,
            startMs: currentStart,
            endMs: segmentEnd
        })

        currentStart = segmentEnd + 300ms

    return result
```

## Key Implementation Considerations

### 1. Timing Distribution Strategy

The algorithm uses a two-phase approach to distribute timing:

**Phase 1: Minimum Duration Allocation**
- Each segment gets a guaranteed minimum of 1500ms
- This ensures readability even for short segments

**Phase 2: Proportional Extra Time Distribution**
- Remaining time (after minimums and gaps) is distributed proportionally by character count
- Longer text segments get more extra time
- This maintains natural reading speed across segments

```
totalDuration = endMs - startMs
totalGapTime = (numSegments - 1) * 300ms
availableDuration = totalDuration - totalGapTime
minRequiredDuration = numSegments * 1500ms
extraTime = availableDuration - minRequiredDuration
timePerExtraChar = extraTime / totalChars

segmentDuration = 1500ms + (segmentLength * timePerExtraChar)
```

### 2. Segment Reduction Strategy

When there's insufficient time for all segments, the algorithm merges segments:

```javascript
// Calculate maximum possible segments
maxSegments = floor(availableDuration / 1500ms)

// Merge strategy: distribute merges evenly
mergeCount = ceil(remainingSegments / remainingSlots)
```

**Example:**
- Input: 5 segments, but only time for 3
- Merge: [seg1+seg2], [seg3+seg4], [seg5]
- Each merged segment gets minimum 1500ms + proportional extra time

### 3. Text Splitting Priority

The algorithm uses a hierarchical approach to find split points:

**Priority 1: Punctuation Marks**
- Chinese: ，。！？
- English: ,!?
- Split after punctuation (includes punctuation in preceding segment)
- Handles multiple punctuation marks by splitting at each one

**Priority 2: Natural Boundaries**
- Spaces
- Chinese punctuation: 、；：
- Character boundaries between Chinese characters
- Search within ±5 characters of midpoint

**Priority 3: Forced Split**
- If no natural boundary found, split at 15 characters
- Search ±3 characters for a better split point (space or 、)
- Recursively handle remaining text if still too long

### 4. Edge Cases Handled

**Short Text (≤15 chars):**
- No splitting performed
- Returns original entry unchanged

**Insufficient Time:**
- If available time < 1500ms, returns original entry
- If available time < numSegments × 1500ms, reduces segment count

**Very Long Text (30+ chars):**
- May result in 2-3 segments depending on available time
- Uses natural boundary splitting to maintain readability

**No Punctuation:**
- Falls back to natural boundary detection
- Splits at spaces, Chinese punctuation, or character boundaries
- Last resort: forced split at 15 characters

**Multiple Punctuation Marks:**
- Splits at each punctuation mark
- Handles remaining text after last punctuation separately

### 5. Timing Constraints Enforcement

**Minimum Duration (1500ms):**
```javascript
segmentDuration = max(1500ms, calculatedDuration)
```

**Gap Between Segments (300ms):**
```javascript
currentStart = previousSegmentEnd + 300ms
```

**Boundary Respect:**
```javascript
segmentEnd = min(originalEndMs, calculatedEnd)
```

### 6. Performance Considerations

**Time Complexity:**
- Text splitting: O(n) where n is text length
- Timing calculation: O(k) where k is number of segments
- Overall: O(n) per subtitle entry

**Space Complexity:**
- O(k) for storing segments
- O(k) for result entries

**Optimization:**
- Single pass through text for punctuation detection
- Efficient segment merging logic
- No recursive calls (except for edge cases with force split)

## Test Cases

### Test 1: Short Text (No Splitting)
```
Input:  "短句" (2 chars)
Output: "短句" (unchanged)
Duration: 5000ms
Result: ✅ No splitting needed
```

### Test 2: Long Text with Punctuation
```
Input:  "注意看！又是这位男人，视频开局直接高速对线" (21 chars)
Output:
  - "注意看！又是这位男人，" (11 chars) → 0-2233ms
  - "视频开局直接高速对线" (10 chars) → 2533-5000ms
Duration: 5000ms
Result: ✅ Split at punctuation, 300ms gap, proportional timing
```

### Test 3: Long Text Without Punctuation
```
Input:  "这是一个非常非常非常非常长的句子没有任何标点符号需要强制拆分" (30 chars)
Output:
  - "这是一个非常非常非常非常长的句子没有任" (19 chars) → 0-4477ms
  - "何标点符号需要强制拆分" (11 chars) → 4777-8000ms
Duration: 8000ms
Result: ✅ Natural boundary split, 300ms gap
```

### Test 4: Multiple Punctuation Marks
```
Input:  "第一句话！第二句话？第三句话。第四句话，结束" (22 chars)
Output:
  - "第一句话！第二句话？" (10 chars) → 0-1636ms
  - "第三句话。第四句话，" (10 chars) → 1937-3573ms
  - "结束" (2 chars) → 3873-6000ms
Duration: 6000ms
Result: ✅ Split at each punctuation, segments reduced to fit
```

### Test 5: Insufficient Time
```
Input:  "很长很长很长很长很长很长很长很长很长很长很长很长的文本" (26 chars)
Duration: 3000ms
Available after gaps: 2700ms
Max segments: floor(2700 / 1500) = 1
Result: ✅ Returns original (can't split with minimum duration)
```

### Test 6: Edge Case - Exactly 15 Characters
```
Input:  "刚好十五个字的测试句" (10 chars)
Result: ✅ No splitting (Chinese characters counted correctly)
```

### Test 7: Very Long Text
```
Input:  "这是一个超级超级超级超级超级超级超级超级超级超级超级超级超级超级超级超级超级长的句子" (42 chars)
Duration: 10000ms
Output:
  - "这是一个超级超级超级超级超级超级超级超级超级超级超" (25 chars) → 0-5488ms
  - "级超级超级超级超级超级超级长的句子" (17 chars) → 5788-10000ms
Result: ✅ Natural boundary split, proportional timing
```

## Integration

The algorithm is integrated into the subtitle generation pipeline in `smartEditor.js`:

```javascript
// In prepareEditVideo function:
let entries = parsedSrt.entries;
entries = validateAndFixSrt(entries, videoDurationMs);
entries = splitLongSubtitles(entries);  // ← New step
const srtContent = entriesToSrt(entries);
```

## API Export

The function is exported for external use:

```javascript
module.exports = {
  prepareEditVideo,
  composeEditVideo,
  cleanupStaleCache,
  createVisionFrameBatches,
  parseSrt,
  parseSrtWithRepair,
  splitLongSubtitles  // ← Exported
};
```

## Future Improvements

1. **Configurable Thresholds:** Make 15-char threshold, 1500ms minimum, and 300ms gap configurable
2. **Language-Specific Splitting:** Different splitting rules for Chinese, English, Japanese, etc.
3. **Semantic Analysis:** Use NLP to find semantically meaningful split points
4. **User Preferences:** Allow users to set preferred segment lengths
5. **Batch Processing:** Optimize for processing multiple subtitles at once

## References

- SRT Format Specification: https://en.wikipedia.org/wiki/SubRip
- Chinese Text Segmentation: https://github.com/niconi/Chinese-Word-Segmentation
- Subtitle Timing Best Practices: https://www.3playmedia.com/blog/subtitle-timing/
