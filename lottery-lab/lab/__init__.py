"""Lottery-Lab: a rigorous research toolkit for lottery draw analysis.

Scientific stance: in a fair lottery draws are independent, so past draws do
NOT predict future ones. This toolkit is built to (1) AUDIT fairness honestly
and (2) study the payout side (the only real edge), not to "predict" numbers.
"""

# Game definition for Stoloto "5 из 36 плюс" (5x36plus)
GAME = {
    "name": "5x36plus",
    "main_n": 36,   # main pool: numbers 1..36
    "main_k": 5,    # 5 drawn, without replacement
    "plus_n": 4,    # "плюс" pool: numbers 1..4
    "plus_k": 1,    # 1 drawn
}
