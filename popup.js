let pairCount = 0;

function createPair(data = null) {
  pairCount++;
  const container = document.getElementById('pairs-container');
  const pair = document.createElement('div');
  pair.className = 'pair';
  pair.dataset.id = pairCount;
  pair.innerHTML = `
    <div class="pair-header">
      <span class="pair-number">#${pairCount}</span>
      <button class="remove-btn" title="Remove">&times;</button>
    </div>
    <div class="field">
      <label>Find</label>
      <input type="text" class="find-input" placeholder="Text to find...">
    </div>
    <div class="field">
      <label>Replace with</label>
      <input type="text" class="replace-input" placeholder="Replacement text...">
    </div>
    <div class="options">
      <label class="checkbox-label">
        <input type="checkbox" class="case-sensitive">
        Case sensitive
      </label>
      <label class="checkbox-label">
        <input type="checkbox" class="use-regex">
        Use regex
      </label>
    </div>
  `;

  pair.querySelector('.remove-btn').addEventListener('click', () => {
    if (document.querySelectorAll('.pair').length > 1) {
      pair.remove();
      renumberPairs();
      savePairs();
    }
  });

  // Add change listeners to save on edit
  pair.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', savePairs);
    input.addEventListener('change', savePairs);
  });

  container.appendChild(pair);

  // Populate with data if provided
  if (data) {
    pair.querySelector('.find-input').value = data.find || '';
    pair.querySelector('.replace-input').value = data.replace || '';
    pair.querySelector('.case-sensitive').checked = data.caseSensitive || false;
    pair.querySelector('.use-regex').checked = data.useRegex || false;
  } else {
    pair.querySelector('.find-input').focus();
  }

  return pair;
}

function renumberPairs() {
  document.querySelectorAll('.pair').forEach((pair, index) => {
    pair.querySelector('.pair-number').textContent = `#${index + 1}`;
  });
}

function savePairs() {
  const pairs = [];
  document.querySelectorAll('.pair').forEach(pair => {
    pairs.push({
      find: pair.querySelector('.find-input').value,
      replace: pair.querySelector('.replace-input').value,
      caseSensitive: pair.querySelector('.case-sensitive').checked,
      useRegex: pair.querySelector('.use-regex').checked
    });
  });
  chrome.storage.local.set({ savedPairs: pairs });
}

async function loadPairs() {
  const result = await chrome.storage.local.get('savedPairs');
  const savedPairs = result.savedPairs;

  if (savedPairs && savedPairs.length > 0) {
    savedPairs.forEach(data => createPair(data));
  } else {
    createPair();
  }
}

function getPairs() {
  const pairs = [];
  document.querySelectorAll('.pair').forEach(pair => {
    const find = pair.querySelector('.find-input').value;
    const replace = pair.querySelector('.replace-input').value;
    const caseSensitive = pair.querySelector('.case-sensitive').checked;
    const useRegex = pair.querySelector('.use-regex').checked;

    if (find) {
      pairs.push({ find, replace, caseSensitive, useRegex });
    }
  });
  return pairs;
}

function showStatus(message, isError = false) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${isError ? 'error' : 'success'}`;
  setTimeout(() => {
    status.className = 'status';
  }, 3000);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('add-pair').addEventListener('click', () => {
    createPair();
    savePairs();
  });

  document.getElementById('replace-all').addEventListener('click', async () => {
    const pairs = getPairs();

    if (pairs.length === 0) {
      showStatus('Please enter at least one find/replace pair', true);
      return;
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: performReplacements,
        args: [pairs]
      });

      const totalReplacements = results[0].result;
      showStatus(`Replaced ${totalReplacements} occurrence${totalReplacements !== 1 ? 's' : ''}`);
    } catch (error) {
      showStatus('Error: ' + error.message, true);
    }
  });

  document.getElementById('undo').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: undoReplacements
      });

      if (results[0].result) {
        showStatus('Undo successful');
      } else {
        showStatus('Nothing to undo', true);
      }
    } catch (error) {
      showStatus('Error: ' + error.message, true);
    }
  });

  // Load saved pairs or create one empty pair
  loadPairs();
});

function performReplacements(pairs) {
  if (!window._findReplaceHistory) {
    window._findReplaceHistory = [];
  }

  let totalCount = 0;
  const snapshot = [];

  // Get all form inputs
  const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input:not([type]), textarea, [contenteditable="true"]');

  inputs.forEach((input, index) => {
    const isContentEditable = input.hasAttribute('contenteditable');
    let text = isContentEditable ? input.innerHTML : input.value;
    const originalText = text;

    // Save original for undo
    snapshot.push({ index, original: originalText, isContentEditable });

    for (const pair of pairs) {
      let regex;
      if (pair.useRegex) {
        try {
          regex = new RegExp(pair.find, pair.caseSensitive ? 'g' : 'gi');
        } catch (e) {
          continue;
        }
      } else {
        const escaped = pair.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(escaped, pair.caseSensitive ? 'g' : 'gi');
      }

      // Only replace if find pattern exists and wouldn't create duplicate
      // Skip if: find doesn't exist OR (replace exists AND find doesn't exist independently)
      const findMatches = text.match(regex);
      if (!findMatches) {
        continue; // Nothing to replace
      }

      // Check if replacement would be redundant (find text is already part of replace text in the content)
      // This prevents "foo" -> "foobar" from running twice
      if (pair.replace && pair.find !== pair.replace) {
        const replaceEscaped = pair.replace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const alreadyReplacedRegex = new RegExp(replaceEscaped, pair.caseSensitive ? 'g' : 'gi');
        const alreadyReplaced = text.match(alreadyReplacedRegex);

        // If replacement text exists same number of times as find text, likely already done
        if (alreadyReplaced && alreadyReplaced.length >= findMatches.length) {
          continue;
        }
      }

      totalCount += findMatches.length;
      text = text.replace(regex, pair.replace);
    }

    if (text !== originalText) {
      if (isContentEditable) {
        input.innerHTML = text;
      } else {
        input.value = text;
        // Trigger input event so frameworks detect the change
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  });

  if (totalCount > 0) {
    window._findReplaceHistory.push(snapshot);
  }

  return totalCount;
}

function undoReplacements() {
  if (window._findReplaceHistory && window._findReplaceHistory.length > 0) {
    const snapshot = window._findReplaceHistory.pop();
    const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input:not([type]), textarea, [contenteditable="true"]');

    snapshot.forEach(item => {
      const input = inputs[item.index];
      if (input) {
        if (item.isContentEditable) {
          input.innerHTML = item.original;
        } else {
          input.value = item.original;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
    return true;
  }
  return false;
}