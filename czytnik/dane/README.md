# dane/ — konfiguracja Czytnika (wchodzi do obrazu)

`pracownicy.json` to lista umów o pracę i wszystko, co system o nich wie:
stawki dnia nieobecności, grupy (stajnia/bar/kuchnia), źródło godzin per obiekt,
osoby na zmianach 12/12, mapy imion z grafiku i nazwisk z kart, działy.

Leży TU, a nie w `korpus/`, bo `korpus/` jest wycięty z obrazu produkcyjnego
(`.dockerignore`: 42 MB skanów kart — dane osobowe do ewaluacji, niepotrzebne
w runtime). Lista pracowników jest natomiast potrzebna przy każdym żądaniu
`/czytnik/karty-do-druku` i bez niej endpoint zwracał „brak listy osob".
