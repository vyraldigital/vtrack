import re

with open("src/App.tsx", "r") as f:
    content = f.read()

# Global background/text
content = content.replace('bg-slate-950 text-slate-50', 'bg-slate-50 text-slate-900')

# Loading screen
content = content.replace('bg-slate-950', 'bg-slate-50')
content = content.replace('text-blue-500', 'text-blue-600')
content = content.replace('text-slate-400', 'text-slate-500')

# Text colors
content = content.replace('text-white', 'text-slate-900')
# Revert button text back to white
content = content.replace('text-slate-900 rounded-xl', 'text-white rounded-xl')
content = content.replace('text-slate-900 hover:bg-slate-200', 'text-white hover:bg-slate-800')

# Adjust text for specific elements
content = content.replace('text-slate-300', 'text-slate-600')

# Backgrounds and borders
content = content.replace('bg-white/5', 'bg-white')
content = content.replace('border-white/10', 'border-slate-200')
content = content.replace('bg-slate-900/50', 'bg-white')
content = content.replace('bg-slate-900', 'bg-white')
content = content.replace('bg-transparent', 'bg-white')

# Specific fixes for gradient ring in profile
content = content.replace('bg-gradient-to-br from-blue-500 to-indigo-600', 'bg-white border border-slate-200')

# Drop shadows
content = content.replace('shadow-2xl', 'shadow-sm')
content = content.replace('shadow-lg', 'shadow-sm')

with open("src/App.tsx", "w") as f:
    f.write(content)
