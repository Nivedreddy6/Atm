/* ==========================================================================
   NEXUS BANK ATM - CLIENT CORE LOGIC
   ========================================================================== */

// --- Session & State Store ---
let sessionToken = null;
let currentCardNumber = null;
let currentHolderName = null;
let currentAccountNumber = null;

// --- API Base resolution for file:// support ---
const API_BASE = window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';

// UI Input States
let pinInput = "";
let customAmountInput = "";
let depositInput = "";
let depositBills = { 100: 0, 50: 0, 20: 0, 10: 0 };
let pinChangeOld = "";
let pinChangeNew = "";
let pinChangeStep = 1; // 1 = Old PIN, 2 = New PIN

// Audio Context for Beep Tones (lazy initialized)
let audioCtx = null;

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function playBeep(freq = 1000, duration = 0.06, type = "sine") {
    try {
        initAudio();
        if (!audioCtx) return;
        
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        
        osc.type = type;
        osc.frequency.value = freq;
        
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    } catch (e) {
        console.warn("Audio play blocked/failed:", e);
    }
}

// Chime Presets
const chimes = {
    click: () => playBeep(1100, 0.05, "sine"),
    cmdClick: () => playBeep(1300, 0.08, "sine"),
    success: () => {
        playBeep(900, 0.1, "sine");
        setTimeout(() => playBeep(1350, 0.2, "sine"), 90);
    },
    error: () => {
        playBeep(320, 0.15, "triangle");
        setTimeout(() => playBeep(250, 0.2, "triangle"), 120);
    },
    dispense: () => {
        // Whirring mechanical motor noise simulation
        let time = 0;
        for (let i = 0; i < 6; i++) {
            setTimeout(() => playBeep(300 + (i * 50), 0.12, "sawtooth"), time);
            time += 100;
        }
    },
    print: () => {
        // High pitched thermal print whirr
        let time = 0;
        for (let i = 0; i < 4; i++) {
            setTimeout(() => playBeep(2000, 0.08, "sine"), time);
            time += 150;
            setTimeout(() => playBeep(2200, 0.08, "sine"), time);
            time += 150;
        }
    }
};

// --- DOM References ---
const views = {
    welcome: document.getElementById("viewWelcome"),
    pin: document.getElementById("viewPin"),
    menu: document.getElementById("viewMenu"),
    balance: document.getElementById("viewBalance"),
    withdraw: document.getElementById("viewWithdraw"),
    customAmount: document.getElementById("viewCustomAmount"),
    deposit: document.getElementById("viewDeposit"),
    pinChange: document.getElementById("viewPinChange"),
    processing: document.getElementById("viewProcessing"),
    history: document.getElementById("viewHistory"),
    status: document.getElementById("viewStatus")
};

// LED Indicator
const cardLed = document.getElementById("cardLed");

// Init application on load
window.addEventListener("DOMContentLoaded", () => {
    // Enable slot LED blinking
    cardLed.classList.add("active");
    
    // Wire up events
    setupEventHandlers();
    
    // Setup Perspective Tilt Effect for ATM Cabinet
    setupPerspectiveTilt();
    
    // Initial fetch of developer settings & state
    refreshDevConsole();
});

// --- State Transitions ---
function switchView(viewName) {
    // Hide all views
    Object.values(views).forEach(v => v.classList.remove("active"));
    
    // Show target view
    if (views[viewName]) {
        views[viewName].classList.add("active");
    }
    
    // Toggle logged-in class to hide security scanner/telemetry overlays
    const screenEl = document.getElementById("atmScreen");
    if (screenEl) {
        if (sessionToken) {
            screenEl.classList.add("logged-in");
        } else {
            screenEl.classList.remove("logged-in");
        }
    }
    
    // Reset specific view input forms on transition
    if (viewName === "pin") {
        pinInput = "";
        updatePinDisplay();
        document.getElementById("pinError").innerText = "";
    } else if (viewName === "customAmount") {
        customAmountInput = "";
        updateAmountDisplay("customAmountText", "0");
        document.getElementById("withdrawError").innerText = "";
    } else if (viewName === "deposit") {
        depositBills = { 100: 0, 50: 0, 20: 0, 10: 0 };
        depositInput = "";
        updateDepositDisplay();
        document.getElementById("depositError").innerText = "";
    } else if (viewName === "pinChange") {
        pinChangeOld = "";
        pinChangeNew = "";
        pinChangeStep = 1;
        document.getElementById("oldPinFake").className = "fake-input active";
        document.getElementById("oldPinFake").innerText = "Enter PIN";
        document.getElementById("newPinFake").className = "fake-input disabled";
        document.getElementById("newPinFake").innerText = "Enter PIN";
        document.getElementById("groupNewPin").classList.add("disabled");
        document.getElementById("pinChangeError").innerText = "";
        document.getElementById("btnNextPinChange").innerText = "Next";
    }
}

// --- Event Listeners Mapping ---
function setupEventHandlers() {
    // 1. Menu Buttons
    document.querySelectorAll(".menu-btn, .control-btn-secondary, .control-btn-primary, .cash-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const action = btn.getAttribute("data-action");
            const amount = btn.getAttribute("data-amount");
            
            if (action) {
                chimes.cmdClick();
                handleMenuAction(action);
            } else if (amount) {
                chimes.cmdClick();
                if (amount === "other") {
                    switchView("customAmount");
                } else {
                    executeWithdraw(parseInt(amount));
                }
            }
        });
    });

    // 2. Tactile Keypad
    document.querySelectorAll(".key-btn").forEach(key => {
        key.addEventListener("click", () => {
            const val = key.getAttribute("data-key");
            handleKeyPress(val);
        });
    });

    // Support physical keyboard bindings
    document.addEventListener("keydown", (e) => {
        // If an input tag is currently focused in developer panel, don't hijack keyboard
        if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT") {
            return;
        }

        const key = e.key;
        if (key >= "0" && key <= "9") {
            handleKeyPress(key);
        } else if (key === "Enter") {
            handleKeyPress("enter");
        } else if (key === "Backspace" || key === "Escape") {
            handleKeyPress("clear");
        }
    });

    // 3. Collect money stack
    document.getElementById("cashDispenser").addEventListener("click", () => {
        const cashStack = document.getElementById("cashStack");
        if (cashStack.classList.contains("visible")) {
            chimes.success();
            cashStack.classList.remove("visible");
            document.getElementById("cashGlow").classList.remove("dispensing");
            // Clear contents after animation transition
            setTimeout(() => { cashStack.innerHTML = ""; }, 500);
        }
    });

    // 4. Collect printed receipt
    document.getElementById("dispensedReceipt").addEventListener("click", () => {
        const receipt = document.getElementById("dispensedReceipt");
        if (receipt.classList.contains("visible")) {
            chimes.success();
            receipt.classList.remove("visible");
        }
    });

    // 5. Developer Panel Actions
    document.getElementById("refreshLogsBtn").addEventListener("click", () => {
        refreshDevConsole();
    });

    document.getElementById("refillVaultBtn").addEventListener("click", () => {
        const amt = parseFloat(document.getElementById("refillAmount").value);
        if (!isNaN(amt) && amt > 0) {
            adminRefillVault(amt);
        }
    });

    document.getElementById("unlockCardBtn").addEventListener("click", () => {
        const cardNo = document.getElementById("lockSelect").value;
        if (cardNo) {
            adminUnlockCard(cardNo);
        }
    });

    document.getElementById("createUserBtn").addEventListener("click", () => {
        const holderName = document.getElementById("newHolderName").value.trim();
        const cardNo = document.getElementById("newCardNumber").value.replace(/\s+/g, ""); // Strip all spaces
        const pin = document.getElementById("newPin").value.trim();
        const initialBalance = parseFloat(document.getElementById("newBalance").value);

        if (!holderName || cardNo.length !== 16 || pin.length !== 4 || isNaN(initialBalance) || initialBalance < 0) {
            chimes.error();
            alert("Please fill all fields correctly:\n- Name must not be blank.\n- Card number must be 16 digits (spaces allowed).\n- PIN must be 4 digits.\n- Initial balance must be >= $0.");
            return;
        }

        const cardThemeObj = {
            color_start: document.getElementById("themeColorStart").value,
            color_end: document.getElementById("themeColorEnd").value,
            pattern: document.getElementById("themePattern").value,
            emblem: document.getElementById("themeEmblem").value,
            image_url: document.getElementById("themeImageUrl").value.trim()
        };
        const cardThemeJson = JSON.stringify(cardThemeObj);

        adminCreateUser(holderName, cardNo, pin, initialBalance, cardThemeJson);
    });

    // Wire up deposit bill selector counters
    document.querySelectorAll(".bill-count-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const denom = parseInt(btn.getAttribute("data-denom"));
            const isPlus = btn.classList.contains("plus");
            
            chimes.click();
            if (isPlus) {
                depositBills[denom]++;
            } else {
                if (depositBills[denom] > 0) {
                    depositBills[denom]--;
                }
            }
            updateDepositDisplay();
            // Sync typed depositInput to match screen count total
            depositInput = getDepositTotal().toString();
        });
    });

    // Wire up PIN Change screen buttons
    document.getElementById("btnBackPinChange").addEventListener("click", () => {
        chimes.cmdClick();
        switchView("menu");
    });

    document.getElementById("btnNextPinChange").addEventListener("click", () => {
        chimes.cmdClick();
        if (pinChangeStep === 1) {
            if (pinChangeOld.length === 4) {
                // Move to next step
                pinChangeStep = 2;
                document.getElementById("oldPinFake").classList.remove("active");
                document.getElementById("newPinFake").className = "fake-input active";
                document.getElementById("groupNewPin").classList.remove("disabled");
                document.getElementById("pinChangeError").innerText = "";
                document.getElementById("btnNextPinChange").innerText = "Confirm";
            } else {
                chimes.error();
                document.getElementById("pinChangeError").innerText = "Verify current 4-digit PIN first";
            }
        } else {
            if (pinChangeNew.length === 4) {
                submitPinChange(pinChangeOld, pinChangeNew);
            } else {
                chimes.error();
                document.getElementById("pinChangeError").innerText = "New PIN must be 4 digits";
            }
        }
    });
}

// --- Menu Actions Logic ---
function handleMenuAction(action) {
    switch (action) {
        case "go-balance":
            fetchBalance();
            break;
        case "go-withdraw":
            switchView("withdraw");
            break;
        case "go-deposit":
            switchView("deposit");
            break;
        case "go-history":
            fetchHistory();
            break;
        case "go-pinchange":
            switchView("pinChange");
            break;
        case "menu":
            switchView("menu");
            break;
        case "eject":
            ejectCard();
            break;
        case "print-balance":
            printBalanceReceipt();
            break;
        case "print-statement":
            printStatementReceipt();
            break;
        case "confirm-withdraw":
            const wAmt = parseInt(customAmountInput);
            if (!isNaN(wAmt) && wAmt > 0) {
                executeWithdraw(wAmt);
            } else {
                chimes.error();
                document.getElementById("withdrawError").innerText = "Enter a valid cash amount";
            }
            break;
        case "confirm-deposit":
            const dAmt = getDepositTotal();
            executeDeposit(dAmt);
            break;
    }
}

// --- Keypad Entries Router ---
function handleKeyPress(val) {
    // Detect which view is open to route inputs
    const activeView = Object.keys(views).find(key => views[key].classList.contains("active"));

    if (val === "cancel") {
        chimes.error();
        if (sessionToken) {
            switchView("menu");
        } else {
            ejectCard();
        }
        return;
    }

    switch (activeView) {
        case "pin":
            handlePinInput(val);
            break;
        case "customAmount":
            handleCustomAmountInput(val);
            break;
        case "deposit":
            handleDepositInput(val);
            break;
        case "pinChange":
            handlePinChangeInput(val);
            break;
        default:
            chimes.click(); // Standard feedback tone
            break;
    }
}

// --- Specific Inputs Handling ---

// 1. Welcome Card Verification PIN
function handlePinInput(val) {
    if (val === "clear") {
        chimes.click();
        pinInput = "";
        updatePinDisplay();
    } else if (val === "enter") {
        if (pinInput.length === 4) {
            chimes.cmdClick();
            verifyPin(currentCardNumber, pinInput);
        } else {
            chimes.error();
            document.getElementById("pinError").innerText = "Enter standard 4-digit PIN";
        }
    } else {
        if (pinInput.length < 4) {
            chimes.click();
            pinInput += val;
            updatePinDisplay();
        } else {
            playBeep(600, 0.05); // Max limit cap warning
        }
    }
}

function updatePinDisplay() {
    for (let i = 0; i < 4; i++) {
        const dot = document.getElementById(`dot-${i}`);
        if (i < pinInput.length) {
            dot.classList.add("filled");
        } else {
            dot.classList.remove("filled");
        }
    }
}

// 2. Custom Withdrawal Amount input
function handleCustomAmountInput(val) {
    if (val === "clear") {
        chimes.click();
        customAmountInput = "";
        updateAmountDisplay("customAmountText", "0");
    } else if (val === "enter") {
        chimes.cmdClick();
        const amt = parseInt(customAmountInput);
        if (!isNaN(amt) && amt > 0) {
            executeWithdraw(amt);
        } else {
            chimes.error();
            document.getElementById("withdrawError").innerText = "Enter a valid cash amount";
        }
    } else {
        chimes.click();
        // Prevent exceeding sensible limit size on screen
        if (customAmountInput.length < 5) {
            customAmountInput += val;
            updateAmountDisplay("customAmountText", customAmountInput);
        }
    }
}

// 3. Deposit Amount input
function handleDepositInput(val) {
    if (val === "clear") {
        chimes.click();
        depositInput = "";
        depositBills = { 100: 0, 50: 0, 20: 0, 10: 0 };
        updateDepositDisplay();
    } else if (val === "enter") {
        chimes.cmdClick();
        const amt = getDepositTotal();
        executeDeposit(amt);
    } else {
        // Handle numeric digit keys on deposit screen keypad
        if (/^[0-9]$/.test(val)) {
            chimes.click();
            if (depositInput.length < 5) {
                depositInput += val;
                
                // Calculate greedy bill breakdown matching the typed total
                let tempAmt = parseInt(depositInput || "0");
                let remaining = tempAmt;
                let breakdown = { 100: 0, 50: 0, 20: 0, 10: 0 };
                
                for (let bill of [100, 50, 20, 10]) {
                    let count = Math.floor(remaining / bill);
                    if (count > 0) {
                        breakdown[bill] = count;
                        remaining %= bill;
                    }
                }
                
                depositBills = breakdown;
                updateDepositDisplay();
            }
        } else {
            chimes.click();
        }
    }
}

function updateAmountDisplay(elementId, valString) {
    const formatted = parseInt(valString || "0").toLocaleString();
    document.getElementById(elementId).innerText = formatted;
}

function updateDepositDisplay() {
    let total = 0;
    Object.keys(depositBills).forEach(denom => {
        const count = depositBills[denom];
        document.getElementById(`count-${denom}`).innerText = count;
        total += count * parseInt(denom);
    });
    document.getElementById("depositAmountText").innerText = total.toLocaleString();
}

function getDepositTotal() {
    let total = 0;
    Object.keys(depositBills).forEach(denom => {
        total += depositBills[denom] * parseInt(denom);
    });
    return total;
}

// 4. PIN Change Multi-step Input
function handlePinChangeInput(val) {
    const oldField = document.getElementById("oldPinFake");
    const newField = document.getElementById("newPinFake");

    if (val === "clear") {
        chimes.click();
        if (pinChangeStep === 1) {
            pinChangeOld = "";
            oldField.innerText = "Enter PIN";
            oldField.classList.remove("filled");
        } else {
            pinChangeNew = "";
            newField.innerText = "Enter PIN";
            newField.classList.remove("filled");
        }
        return;
    }

    if (val === "enter") {
        chimes.cmdClick();
        if (pinChangeStep === 1) {
            if (pinChangeOld.length === 4) {
                // Move to next step
                pinChangeStep = 2;
                oldField.classList.remove("active");
                newField.className = "fake-input active";
                document.getElementById("groupNewPin").classList.remove("disabled");
                document.getElementById("pinChangeError").innerText = "";
                document.getElementById("btnNextPinChange").innerText = "Confirm";
            } else {
                chimes.error();
                document.getElementById("pinChangeError").innerText = "Verify current 4-digit PIN first";
            }
        } else {
            if (pinChangeNew.length === 4) {
                submitPinChange(pinChangeOld, pinChangeNew);
            } else {
                chimes.error();
                document.getElementById("pinChangeError").innerText = "New PIN must be 4 digits";
            }
        }
        return;
    }

    // Entering digit
    chimes.click();
    if (pinChangeStep === 1) {
        if (pinChangeOld.length < 4) {
            pinChangeOld += val;
            oldField.innerText = "*".repeat(pinChangeOld.length);
            if (pinChangeOld.length === 4) oldField.classList.add("filled");
        }
    } else {
        if (pinChangeNew.length < 4) {
            pinChangeNew += val;
            newField.innerText = "*".repeat(pinChangeNew.length);
            if (pinChangeNew.length === 4) newField.classList.add("filled");
        }
    }
}

// --- API Calls & Handlers ---

// 1. Insert Card
function insertCardSimulator(cardNo, holderName) {
    if (sessionToken || currentCardNumber) {
        chimes.error();
        alert("A card is already loaded in the terminal. Eject it first.");
        return;
    }

    // Trigger physical card slider animation
    const insertedCard = document.getElementById("insertedCard");
    insertedCard.classList.add("visible");

    setTimeout(() => {
        insertedCard.classList.add("inserted");
        
        fetch(`${API_BASE}/api/auth/insert-card`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ card_number: cardNo })
        })
        .then(async res => {
            const data = await res.json();
            if (res.ok) {
                chimes.success();
                currentCardNumber = cardNo;
                currentHolderName = holderName;
                
                // Set green LED
                cardLed.classList.remove("active"); // Stops blinking
                cardLed.style.backgroundColor = "var(--color-success)";
                
                // Show PIN Verification Screen
                document.getElementById("pinGreeting").innerText = `Welcome, ${holderName}`;
                switchView("pin");
            } else {
                chimes.error();
                alert(data.detail || "Card insertion failed");
                // Reset card visually
                insertedCard.className = "inserted-card";
            }
        })
        .catch(err => {
            chimes.error();
            console.error("Insert card error:", err);
            insertedCard.className = "inserted-card";
        });
    }, 600);
}

// 2. PIN Verify
function verifyPin(cardNo, pin) {
    switchView("processing");
    
    fetch(`${API_BASE}/api/auth/verify-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_number: cardNo, pin: pin })
    })
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            chimes.success();
            sessionToken = data.token;
            currentAccountNumber = data.account_number;
            
            document.getElementById("userName").innerText = data.holder_name;
            document.getElementById("userAccNo").innerText = data.account_number;
            
            switchView("menu");
            refreshDevConsole();
        } else {
            chimes.error();
            // If card became locked
            if (res.status === 403) {
                alert(data.detail);
                ejectCardVisualsOnly();
            } else {
                switchView("pin");
                document.getElementById("pinError").innerText = data.detail;
            }
            refreshDevConsole();
        }
    })
    .catch(err => {
        chimes.error();
        console.error(err);
        switchView("pin");
        document.getElementById("pinError").innerText = "Network connection failed";
    });
}

// 3. Fetch Balance
function fetchBalance() {
    switchView("processing");
    
    fetch(`${API_BASE}/api/account/balance`, {
        headers: { "Authorization": `Bearer ${sessionToken}` }
    })
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            document.getElementById("balanceText").innerText = `$${data.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
            document.getElementById("balanceAcc").innerText = data.account_number;
            switchView("balance");
        } else {
            handleSessionError(data.detail);
        }
    })
    .catch(err => {
        chimes.error();
        switchView("menu");
    });
}

// 4. Execute cash withdrawal
function executeWithdraw(amount) {
    if (amount % 10 !== 0) {
        document.getElementById("withdrawError").innerText = "Error: Amount must be in multiples of $10";
        chimes.error();
        return;
    }
    if (amount > 1000) {
        document.getElementById("withdrawError").innerText = "Error: Single transaction limit is $1,000";
        chimes.error();
        return;
    }

    switchView("processing");
    
    fetch(`${API_BASE}/api/account/withdraw`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ amount: amount })
    })
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            // Dispense visual bills
            dispenseCashVisuals(data.bills);
            
            // Show Success Status
            showStatus(true, "Transaction Approved", `Dispensed $${amount}. Take your cash below.`, true);
            refreshDevConsole();
        } else {
            showStatus(false, "Transaction Failed", data.detail || "Failed to process withdrawal", false);
            refreshDevConsole();
        }
    })
    .catch(err => {
        chimes.error();
        showStatus(false, "System Error", "Communication link timed out", false);
    });
}

function dispenseCashVisuals(bills) {
    chimes.dispense();
    const cashStack = document.getElementById("cashStack");
    cashStack.innerHTML = "";
    
    // Glow dispenser
    document.getElementById("cashGlow").classList.add("dispensing");
    
    // Add bill overlays
    let delay = 0;
    Object.keys(bills).forEach(denomination => {
        const count = bills[denomination];
        for (let i = 0; i < count; i++) {
            const bill = document.createElement("div");
            bill.className = "cash-bill";
            bill.innerHTML = `
                <div class="bill-corner">$${denomination}</div>
                <div class="bill-center">${denomination}</div>
                <div class="bill-corner bottom">$${denomination}</div>
            `;
            // Add subtle random offsets to stack realism
            const rotate = (Math.random() * 6 - 3).toFixed(1);
            const xOffset = (Math.random() * 10 - 5).toFixed(0);
            const yOffset = (i * 4).toFixed(0); // Vertical stacking depth
            
            bill.style.transform = `rotate(${rotate}deg) translate(${xOffset}px, -${yOffset}px)`;
            bill.style.zIndex = i;
            
            cashStack.appendChild(bill);
        }
    });

    // Slide out cash stack
    setTimeout(() => {
        cashStack.classList.add("visible");
    }, 150);
}

// 5. Execute Deposit
function executeDeposit(amount) {
    if (amount <= 0) {
        document.getElementById("depositError").innerText = "Error: Select at least one bill to deposit";
        chimes.error();
        return;
    }
    if (amount > 5000) {
        document.getElementById("depositError").innerText = "Error: Maximum deposit limit is $5,000";
        chimes.error();
        return;
    }

    // 1. Spawn cash bills in dispenser to represent the insertion visually
    dispenseCashVisuals(depositBills);
    
    // 2. Animate sliding them inside the cabinet slot
    setTimeout(() => {
        chimes.dispense(); // play motor whirr sound
        const cashStack = document.getElementById("cashStack");
        
        cashStack.style.transition = "all 1.0s cubic-bezier(0.25, 0.8, 0.25, 1)";
        cashStack.style.transform = "translateY(-40px) scale(0.2)";
        cashStack.style.opacity = "0";
        document.getElementById("cashGlow").classList.add("dispensing");
        
        setTimeout(() => {
            // Clean stack and restore styles
            cashStack.innerHTML = "";
            cashStack.style.transition = "";
            cashStack.style.transform = "";
            cashStack.style.opacity = "";
            document.getElementById("cashGlow").classList.remove("dispensing");
            
            switchView("processing");
            
            fetch(`${API_BASE}/api/account/deposit`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${sessionToken}`
                },
                body: JSON.stringify({ amount: amount })
            })
            .then(async res => {
                const data = await res.json();
                if (res.ok) {
                    showStatus(true, "Deposit Completed", `$${amount.toLocaleString()} has been credited to your account.`, false);
                    refreshDevConsole();
                } else {
                    showStatus(false, "Deposit Failed", data.detail || "Unable to credit cash", false);
                    refreshDevConsole();
                }
            })
            .catch(err => {
                chimes.error();
                showStatus(false, "System Error", "Deposit window failed", false);
            });
        }, 1000);
    }, 400);
}

// 6. Submit PIN Change
function submitPinChange(oldPin, newPin) {
    switchView("processing");
    
    fetch(`${API_BASE}/api/account/change-pin`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ old_pin: oldPin, new_pin: newPin })
    })
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            showStatus(true, "PIN Updated", "Your card security PIN has been successfully changed.", false);
            refreshDevConsole();
        } else {
            // Return back to pin change screen with error
            switchView("pinChange");
            document.getElementById("pinChangeError").innerText = data.detail || "Pin Change Failed";
        }
    })
    .catch(err => {
        chimes.error();
        switchView("menu");
    });
}

// 7. Fetch Transaction History
function fetchHistory() {
    switchView("processing");
    
    fetch(`${API_BASE}/api/account/transactions`, {
        headers: { "Authorization": `Bearer ${sessionToken}` }
    })
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            const tableBody = document.getElementById("historyTableBody");
            tableBody.innerHTML = "";
            
            if (data.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No recent transactions</td></tr>`;
            } else {
                data.forEach(tx => {
                    const row = document.createElement("tr");
                    const dateFormatted = new Date(tx.timestamp).toLocaleString("en-US", {
                        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                    });
                    
                    const badgeClass = tx.status === "SUCCESS" ? "badge-success" : "badge-danger";
                    const amountSign = tx.type === "DEPOSIT" ? "+" : (tx.type === "WITHDRAWAL" ? "-" : "");
                    const amountColor = tx.type === "DEPOSIT" ? "var(--color-success)" : "inherit";
                    
                    row.innerHTML = `
                        <td style="font-weight:600;">${tx.type}</td>
                        <td style="color:${amountColor}; font-family:var(--font-mono);">${amountSign}$${tx.amount.toLocaleString()}</td>
                        <td>${dateFormatted}</td>
                        <td><span class="${badgeClass}">${tx.status}</span></td>
                    `;
                    tableBody.appendChild(row);
                });
            }
            switchView("history");
        } else {
            handleSessionError(data.detail);
        }
    })
    .catch(err => {
        chimes.error();
        switchView("menu");
    });
}

// 8. Eject Card
function ejectCard() {
    if (!currentCardNumber) return;
    
    fetch(`${API_BASE}/api/auth/eject-card`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${sessionToken}` }
    })
    .finally(() => {
        ejectCardVisualsOnly();
    });
}

function ejectCardVisualsOnly() {
    chimes.cmdClick();
    
    // Clear Session values
    sessionToken = null;
    currentCardNumber = null;
    currentHolderName = null;
    currentAccountNumber = null;

    // Reset LED Indicator to flashing
    cardLed.style.backgroundColor = "";
    cardLed.classList.add("active");

    // Physical card ejection animation
    const insertedCard = document.getElementById("insertedCard");
    insertedCard.classList.remove("inserted");
    
    setTimeout(() => {
        insertedCard.classList.remove("visible");
        switchView("welcome");
        refreshDevConsole();
    }, 600);
}

// --- Receipts Printer Generators ---
function printBalanceReceipt() {
    chimes.print();
    
    fetch(`${API_BASE}/api/account/balance`, {
        headers: { "Authorization": `Bearer ${sessionToken}` }
    })
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            const paper = document.getElementById("receiptContent");
            const dateStr = new Date().toLocaleString();
            
            paper.innerHTML = `
                <div class="receipt-paper-detail">
                    <h3>NEXUS BANK ATM</h3>
                    <p>Terminal #0981 - San Francisco</p>
                    <div class="receipt-divider"></div>
                    <p class="receipt-row"><span>DATE:</span> <span>${dateStr}</span></p>
                    <p class="receipt-row"><span>CARD NUMBER:</span> <span>**** **** **** ${currentCardNumber.slice(-4)}</span></p>
                    <p class="receipt-row"><span>ACCOUNT NO:</span> <span>${data.account_number}</span></p>
                    <p class="receipt-row"><span>CARDHOLDER:</span> <span>${data.holder_name.toUpperCase()}</span></p>
                    <div class="receipt-divider"></div>
                    <p class="receipt-row" style="font-weight:bold; font-size:9px;">
                        <span>AVAILABLE BAL:</span> 
                        <span>$${data.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                    </p>
                    <div class="receipt-divider"></div>
                    <p style="font-style:italic;">Thank you for banking with Nexus!</p>
                    <div class="receipt-barcode">|||| | ||||| | || |||| |</div>
                    <button class="receipt-download-btn" id="downloadReceiptBtn">💾 Save Receipt</button>
                </div>
            `;
            
            // Slide down printed paper
            document.getElementById("dispensedReceipt").classList.add("visible");
            
            document.getElementById("downloadReceiptBtn").addEventListener("click", (e) => {
                e.stopPropagation();
                chimes.success();
                const text = document.getElementById("receiptContent").innerText.replace("💾 Save Receipt", "").trim();
                const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
                const link = document.createElement("a");
                link.href = URL.createObjectURL(blob);
                link.download = `nexus_atm_balance_${Date.now()}.txt`;
                link.click();
            });
        }
    });
}

function printStatementReceipt() {
    chimes.print();
    
    fetch(`${API_BASE}/api/account/transactions`, {
        headers: { "Authorization": `Bearer ${sessionToken}` }
    })
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            const paper = document.getElementById("receiptContent");
            const dateStr = new Date().toLocaleString();
            
            let txRowsHtml = "";
            // Show last 5 transactions on short receipt
            data.slice(0, 5).forEach(tx => {
                const dateShort = new Date(tx.timestamp).toLocaleDateString("en-US", {month:"numeric", day:"numeric"});
                const sign = tx.type === "DEPOSIT" ? "+" : "-";
                txRowsHtml += `
                    <p class="receipt-row">
                        <span>${dateShort} ${tx.type.slice(0,4)}</span> 
                        <span>${sign}$${tx.amount.toFixed(0)} (${tx.status[0]})</span>
                    </p>
                `;
            });
            
            paper.innerHTML = `
                <div class="receipt-paper-detail">
                    <h3>NEXUS BANK ATM</h3>
                    <p>Mini-Statement</p>
                    <div class="receipt-divider"></div>
                    <p class="receipt-row"><span>DATE:</span> <span>${dateStr}</span></p>
                    <p class="receipt-row"><span>ACC NO:</span> <span>${currentAccountNumber}</span></p>
                    <div class="receipt-divider"></div>
                    ${txRowsHtml || "<p>No recent transactions</p>"}
                    <div class="receipt-divider"></div>
                    <p style="font-style:italic;">Nexus: Security & Simplicity</p>
                    <div class="receipt-barcode">||| |||| || | || ||| || ||</div>
                    <button class="receipt-download-btn" id="downloadReceiptBtn">💾 Save Receipt</button>
                </div>
            `;
            
            document.getElementById("dispensedReceipt").classList.add("visible");
            
            document.getElementById("downloadReceiptBtn").addEventListener("click", (e) => {
                e.stopPropagation();
                chimes.success();
                const text = document.getElementById("receiptContent").innerText.replace("💾 Save Receipt", "").trim();
                const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
                const link = document.createElement("a");
                link.href = URL.createObjectURL(blob);
                link.download = `nexus_atm_statement_${Date.now()}.txt`;
                link.click();
            });
        }
    });
}

// --- Session Handler Helper ---
function handleSessionError(detail) {
    chimes.error();
    alert(detail || "Session expired. Ejecting card.");
    ejectCardVisualsOnly();
}

// --- Success/Failure status displayer ---
function showStatus(isSuccess, title, text, showDispenseTip = false) {
    if (isSuccess) {
        chimes.success();
        document.getElementById("statusSuccessIcon").style.display = "flex";
        document.getElementById("statusFailureIcon").style.display = "none";
        document.getElementById("statusTitle").innerText = title;
        document.getElementById("statusTitle").className = "screen-title text-success";
    } else {
        chimes.error();
        document.getElementById("statusSuccessIcon").style.display = "none";
        document.getElementById("statusFailureIcon").style.display = "flex";
        document.getElementById("statusTitle").innerText = title;
        document.getElementById("statusTitle").className = "screen-title text-danger";
    }

    document.getElementById("statusMsg").innerText = text;
    document.getElementById("dispenseTip").style.display = showDispenseTip ? "block" : "none";
    
    switchView("status");

    // Ok Button routes back to menu if logged in, or welcome if not
    document.getElementById("statusOkBtn").onclick = () => {
        chimes.cmdClick();
        if (sessionToken) {
            switchView("menu");
        } else {
            ejectCardVisualsOnly();
        }
    };
}

// --- Developer Console Controllers ---
function refreshDevConsole() {
    fetch(`${API_BASE}/api/admin/status`)
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            // 1. Vault Cash
            document.getElementById("vaultCashText").innerText = `$${data.atm_cash.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
            document.getElementById("statTxCount").innerText = data.total_transactions;
            document.getElementById("statUsersCount").innerText = data.total_users;
            document.getElementById("statLockedCount").innerText = data.locked_cards;

            // 2. Seeded Cards Card Bank
            const cardBank = document.getElementById("cardBank");
            cardBank.innerHTML = "";
            
            // Clean lock dropdown
            const lockSelect = document.getElementById("lockSelect");
            lockSelect.innerHTML = `<option value="">Select locked card...</option>`;
             data.users.forEach(user => {
                const isCardInserted = currentCardNumber === user.card_number;
                const selectedClass = isCardInserted ? "selected" : "";
                
                // Theme selection based on user name or custom theme JSON
                let themeClass = "card-theme-default";
                let inlineStyle = "";
                let patternHtml = "";
                let emblem = "◇";

                if (user.card_theme) {
                    try {
                        const theme = JSON.parse(user.card_theme);
                        if (theme.image_url) {
                            inlineStyle = `background-image: url('${theme.image_url}'); background-size: cover; background-position: center;`;
                        } else if (theme.color_start && theme.color_end) {
                            inlineStyle = `background: linear-gradient(135deg, ${theme.color_start} 0%, ${theme.color_end} 100%);`;
                        }
                        if (theme.pattern && theme.pattern !== "none") {
                            patternHtml = `<div class="card-pattern pattern-${theme.pattern}"></div>`;
                        }
                        if (theme.emblem) {
                            emblem = theme.emblem;
                        }
                        themeClass = "";
                    } catch (e) {
                        console.warn("Failed to parse card theme:", e);
                    }
                } else {
                    if (user.holder_name.includes("Alice")) themeClass = "card-theme-alice";
                    else if (user.holder_name.includes("Bob")) themeClass = "card-theme-bob";
                    else if (user.holder_name.includes("Charlie")) themeClass = "card-theme-charlie";
                }
                
                const item = document.createElement("div");
                item.className = `card-item ${themeClass} ${selectedClass}`;
                if (inlineStyle) {
                    item.style = inlineStyle;
                }
                
                const statusClass = user.status === "ACTIVE" ? "active" : "locked";
                const isLocked = user.status === "LOCKED";
                
                // Render the actual PIN hint populated from the backend state database
                let pinHint = user.pin_hint || "1234";
                
                // Format card number with spacing
                const formattedCardNo = `${user.card_number.slice(0,4)} ${user.card_number.slice(4,8)} ${user.card_number.slice(8,12)} ${user.card_number.slice(-4)}`;
                
                item.innerHTML = `
                    ${patternHtml}
                    <div class="card-header-row">
                        <span class="card-bank-name">${emblem} NEXUS PREMIUM</span>
                        <div class="card-chip"></div>
                    </div>
                    <div class="card-number-display">${formattedCardNo}</div>
                    <div class="card-footer-row">
                        <div style="display:flex; flex-direction:column; gap:2px;">
                            <span class="card-holder-name">${user.holder_name}</span>
                            <span style="font-size:7px; color:rgba(255,255,255,0.6); text-transform:uppercase; font-weight:800; display:flex; align-items:center; gap:4px;">
                                <span class="card-status-dot ${statusClass}"></span> ${user.status}
                            </span>
                        </div>
                        <div class="card-details-small">
                            <span>PIN: <strong>${pinHint}</strong></span>
                            <span>BAL: <strong>$${user.balance.toLocaleString()}</strong></span>
                        </div>
                    </div>
                `;
                
                // Make clickable & Add Tilt Hover Effect
                item.onclick = () => {
                    if (isLocked) {
                        chimes.error();
                        alert("This card is LOCKED. Please unlock it using the Admin tools at the bottom.");
                    } else {
                        insertCardSimulator(user.card_number, user.holder_name);
                    }
                };
                
                item.addEventListener("mousemove", (e) => {
                    const rect = item.getBoundingClientRect();
                    const x = e.clientX - rect.left - rect.width / 2;
                    const y = e.clientY - rect.top - rect.height / 2;
                    const tiltX = -(y / (rect.height / 2)) * 12;
                    const tiltY = (x / (rect.width / 2)) * 12;
                    item.style.transform = `perspective(800px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) translateY(-4px) scale(1.02)`;
                });
                
                item.addEventListener("mouseleave", () => {
                    item.style.transform = "";
                });
                
                cardBank.appendChild(item);
 
                 // Add to unlock dropdown if locked
                 if (isLocked) {
                     const opt = document.createElement("option");
                     opt.value = user.card_number;
                     opt.innerText = `${user.holder_name} (${user.card_number.slice(-4)})`;
                     lockSelect.appendChild(opt);
                 }
             });

            // 3. Transactions Log feed
            const feed = document.getElementById("logsFeed");
            feed.innerHTML = "";
            
            if (data.recent_transactions.length === 0) {
                feed.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding-top:20px;">No entries logged</div>`;
            } else {
                data.recent_transactions.forEach(tx => {
                    const row = document.createElement("div");
                    row.className = "log-row";
                    
                    const timeStr = new Date(tx.timestamp).toLocaleTimeString();
                    const badgeClass = tx.status === "SUCCESS" ? "SUCCESS" : "FAILED";
                    
                    row.innerHTML = `
                        <span class="log-time">[${timeStr}]</span> 
                        <span class="log-type ${tx.type}">${tx.type}</span> 
                        <strong>$${tx.amount.toFixed(0)}</strong> 
                        <span class="log-status ${badgeClass}">${badgeClass}</span>
                        <span class="log-details">- ${tx.holder_name}: ${tx.details || ""}</span>
                    `;
                    feed.appendChild(row);
                });
            }
        }
    });
}

function adminRefillVault(amount) {
    fetch(`${API_BASE}/api/admin/refill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amount })
    })
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            chimes.success();
            document.getElementById("refillAmount").value = "";
            refreshDevConsole();
        }
    });
}

function adminUnlockCard(cardNo) {
    fetch(`${API_BASE}/api/admin/unlock-card`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_number: cardNo })
    })
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            chimes.success();
            refreshDevConsole();
        }
    });
}

function adminCreateUser(holderName, cardNo, pin, initialBalance, cardTheme) {
    fetch(`${API_BASE}/api/admin/create-user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            holder_name: holderName,
            card_number: cardNo,
            pin: pin,
            initial_balance: initialBalance,
            card_theme: cardTheme
        })
    })
    .then(async res => {
        const data = await res.json();
        if (res.ok) {
            chimes.success();
            // Clear inputs
            document.getElementById("newHolderName").value = "";
            document.getElementById("newCardNumber").value = "";
            document.getElementById("newPin").value = "";
            document.getElementById("newBalance").value = "";
            document.getElementById("themeColorStart").value = "#1d4ed8";
            document.getElementById("themeColorEnd").value = "#db2777";
            document.getElementById("themePattern").value = "none";
            document.getElementById("themeEmblem").value = "◇";
            document.getElementById("themeImageUrl").value = "";
            
            alert(`User registered successfully!\nGenerated Account: ${data.account_number}`);
            refreshDevConsole();
        } else {
            chimes.error();
            alert(data.detail || "Failed to create user");
        }
    })
    .catch(err => {
        chimes.error();
        console.error(err);
        alert("Network error while creating account");
    });
}

// --- Perspective Tilt Effect ---
function setupPerspectiveTilt() {
    // Cabinet tilt disabled to keep cabinet stable and aligned
}

